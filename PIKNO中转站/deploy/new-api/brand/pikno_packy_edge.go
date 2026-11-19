package openai

import (
 "bytes"
 "crypto/hmac"
 "crypto/rand"
 "crypto/sha256"
 "encoding/base64"
 "encoding/hex"
 "encoding/json"
 "errors"
 "io"
 "net/http"
 "os"
 "time"

 relaycommon "github.com/QuantumNous/new-api/relay/common"
 "github.com/gin-gonic/gin"
)

// Called by the existing image adaptor AFTER its normal quota reservation.
// Only small JSON crosses ECS; the Worker builds multipart from private R2.
func piknoPackyEdge(c *gin.Context,info *relaycommon.RelayInfo,body io.Reader)(any,error){
 secret:=os.Getenv("PIKNO_MEDIA_TICKET_KEY")
 if os.Getenv("PIKNO_MEDIA_ENABLED")!="true" || len(secret)<32 {return nil,errors.New("media edge unavailable")}
 data,err:=io.ReadAll(io.LimitReader(body,65537));if err!=nil || len(data)>65536{return nil,errors.New("invalid image control payload")}
 requestID:=c.GetString("pikno_edge_request_id")
 if requestID=="" {nonce:=make([]byte,16);if _,err=rand.Read(nonce);err!=nil{return nil,err};requestID=hex.EncodeToString(nonce);c.Set("pikno_edge_request_id",requestID)}
 hash:=sha256.Sum256(data);now:=time.Now().Unix()
 claims:=map[string]any{"v":1,"aud":"pikno-packy-edge","uid":c.GetInt("id"),"id":requestID,"iat":now,"exp":now+60,"sha256":hex.EncodeToString(hash[:]),"path":c.Request.URL.Path}
 encoded,err:=json.Marshal(claims);if err!=nil{return nil,err}
 payload:=base64.RawURLEncoding.EncodeToString(encoded)
 mac:=hmac.New(sha256.New,[]byte(secret));mac.Write([]byte(payload))
 ticket:=payload+"."+base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
 req,err:=http.NewRequestWithContext(c.Request.Context(),"POST","https://www.piknoai.com/media/v1/packy",bytes.NewReader(data));if err!=nil{return nil,err}
 req.Header.Set("Content-Type","application/json")
 req.Header.Set("Authorization","Bearer "+info.ApiKey)
 req.Header.Set("X-Pikno-Edge-Ticket",ticket)
 client:=&http.Client{Timeout:600*time.Second,CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}
 resp,err:=client.Do(req);if err!=nil{return nil,errors.New("media edge request failed; check request history before retrying")}
 return resp,nil
}
