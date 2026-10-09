package controller

import (
 "encoding/base64"
 "net/http/httptest"
 "strings"
 "testing"
 "time"

 "github.com/QuantumNous/new-api/common"
 "github.com/gin-gonic/gin"
 "github.com/stretchr/testify/require"
)

func TestPiknoMediaControlPlane(t *testing.T) {
 gin.SetMode(gin.TestMode)
 t.Setenv("PIKNO_MEDIA_ENABLED","true")
 secret:="test-only-secret-not-for-production-123"
 t.Setenv("PIKNO_MEDIA_TICKET_KEY",secret)
 invoke:=func(handler gin.HandlerFunc,uid int,body string)*httptest.ResponseRecorder {
  w:=httptest.NewRecorder();c,_:=gin.CreateTestContext(w)
  c.Set("id",uid);c.Request=httptest.NewRequest("POST","/",strings.NewReader(body));c.Request.Header.Set("Content-Type","application/json")
  handler(c);return w
 }
 w:=invoke(PiknoMediaUpload,7,`{"content_type":"image/png","size":16}`)
 require.Equal(t,201,w.Code)
 var response struct { ID string `json:"id"`; Ticket string `json:"upload_ticket"`; URL string `json:"upload_url"` }
 require.NoError(t,common.Unmarshal(w.Body.Bytes(),&response))
 require.Len(t,response.ID,32)
 require.Equal(t,"https://www.piknoai.com/media/v1/assets/"+response.ID,response.URL)
 claims,err:=base64.RawURLEncoding.DecodeString(strings.Split(response.Ticket,".")[0]);require.NoError(t,err)
 var p piknoMediaTicket;require.NoError(t,common.Unmarshal(claims,&p));require.Equal(t,7,p.UserID);require.Equal(t,"upload",p.Operation)
 body,err:=common.Marshal(map[string]string{"upload_ticket":response.Ticket});require.NoError(t,err)
 require.Equal(t,403,invoke(PiknoMediaComplete,8,string(body)).Code)
 require.Equal(t,401,invoke(PiknoMediaUpload,0,`{"content_type":"image/png","size":16}`).Code)
 require.Equal(t,400,invoke(PiknoMediaUpload,7,`{"content_type":"text/html","size":16}`).Code)
 require.Equal(t,400,invoke(PiknoMediaUpload,7,`{"content_type":"image/png","size":999999999}`).Code)
 p.Expires=time.Now().Unix()-1
 expired,err:=piknoSignMedia(p,secret);require.NoError(t,err)
 body,err=common.Marshal(map[string]string{"upload_ticket":expired});require.NoError(t,err)
 require.Equal(t,403,invoke(PiknoMediaComplete,7,string(body)).Code)
 t.Setenv("PIKNO_MEDIA_ENABLED","false")
 require.Equal(t,503,invoke(PiknoMediaUpload,7,`{"content_type":"image/png","size":16}`).Code)
}
