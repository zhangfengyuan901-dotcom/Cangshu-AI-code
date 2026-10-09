// Deployment helper: explicitly fetch a draft or publish a reviewed local draft.
// This is not an HTTP endpoint and never accesses the gateway database.
package main

import (
 "context"
 "fmt"
 "os"
 "github.com/QuantumNous/new-api/pkg/piknocatalog"
)

func main(){
 if len(os.Args)!=3 {panic("usage: catalog-bootstrap <sync|publish|inspect> <state-file>")}
 s:=piknocatalog.NewStore(os.Args[2]);var state piknocatalog.State;var err error
 switch os.Args[1] {
 case "sync": state,err=s.Sync(context.Background(),0)
 case "publish":
  state,err=s.Read();if err==nil {state,err=s.Publish(state.Revision,0)}
 case "inspect": state,err=s.Read()
 default: panic("unknown catalog operation")
 }
 if err!=nil {fmt.Fprintln(os.Stderr,err);os.Exit(1)}
 fmt.Printf("state=%s published=%t draft=%t\n",state.Revision,state.Published!=nil,state.Draft!=nil)
 snapshot:=state.Draft;if snapshot==nil {snapshot=state.Published}
 if snapshot!=nil {for _,entry:=range snapshot.Models {fmt.Printf("%s available=%t price_review=%t prices=",entry.ID,entry.Available,entry.PriceIssue);for _,price:=range entry.Prices {fmt.Printf("%s:%.6f/%s ",price.Resolution,price.RetailCNY,price.Unit)};fmt.Println()}}
}
