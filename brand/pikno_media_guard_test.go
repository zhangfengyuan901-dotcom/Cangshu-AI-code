package controller

import (
 "encoding/json"
 "io"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
 "time"

 "github.com/gin-gonic/gin"
 "github.com/stretchr/testify/require"
)

type piknoTestTransport func(*http.Request)(*http.Response,error)
func (f piknoTestTransport) RoundTrip(r *http.Request)(*http.Response,error){return f(r)}

func TestPiknoMediaGuard(t *testing.T) {
 gin.SetMode(gin.TestMode)
 secret:="test-only-media-guard-secret-1234567890"
 t.Setenv("PIKNO_MEDIA_ENABLED","true"); t.Setenv("PIKNO_MEDIA_TICKET_KEY",secret)
 now:=time.Now().Unix()
 p:=piknoMediaTicket{1,"pikno-relay-media",7,strings.Repeat("a",32),"read",now,now+3600,"image/png",16}
 link:=func(p piknoMediaTicket)string{v,err:=piknoSignMedia(p,secret);require.NoError(t,err);return "https://www.piknoai.com/media/v1/assets/"+p.ID+"?ticket="+v}
 valid:=link(p)
 require.NotEmpty(t,valid)
 for _,tc:=range []struct{name,url,kind string;uid int;ok bool}{
  {"valid",valid,"image",7,true}, {"foreign",valid,"image",8,false},
  {"wrong type",valid,"video",7,false}, {"external","https://example.com/a.png","image",7,false},
  {"forged",valid+"x","image",7,false}, {"credentials",strings.Replace(valid,"https://","https://x@",1),"image",7,false},
  {"extra query",valid+"&x=y","image",7,false}, {"duplicate query",valid+"&ticket=x","image",7,false},
  {"fragment",valid+"#x","image",7,false}, {"port",strings.Replace(valid,".com/",".com:443/",1),"image",7,false},
 } {t.Run(tc.name,func(t *testing.T){_,err:=piknoValidateMediaURL(tc.url,tc.uid,tc.kind);require.Equal(t,tc.ok,err==nil)})}
 p.Expires=now-1; _,err:=piknoValidateMediaURL(link(p),7,"image");require.Error(t,err);p.Expires=now+3600
 old:=http.DefaultTransport;defer func(){http.DefaultTransport=old}()
 calls:=0
 http.DefaultTransport=piknoTestTransport(func(r *http.Request)(*http.Response,error){
  calls++;require.Equal(t,"POST",r.Method);require.Equal(t,"www.piknoai.com",r.URL.Host);require.Nil(t,r.Body)
  return &http.Response{StatusCode:200,Body:io.NopCloser(strings.NewReader(`{"id":"`+p.ID+`","owner_id":7,"size":16,"content_type":"image/png","status":"ready"}`)),Header:make(http.Header)},nil
 })
 run:=func(path,body,ct string,uid int)(int,bool){
  next:=false;r:=gin.New();r.POST(path,func(c *gin.Context){c.Set("id",uid)},PiknoMediaGuard,func(c *gin.Context){next=true;data,_:=io.ReadAll(c.Request.Body);require.Equal(t,body,string(data));c.Status(204)})
  req:=httptest.NewRequest("POST",path,strings.NewReader(body));req.Header.Set("Content-Type",ct);w:=httptest.NewRecorder();r.ServeHTTP(w,req);return w.Code,next
 }
 body,_:=json.Marshal(map[string]any{"model":"sanbao/test","image_urls":[]string{valid}})
 for _,path:=range []string{"/v1/videos","/pikno-sanbao/tasks","/pikno-canseedream/tasks"}{code,next:=run(path,string(body),"application/json",7);require.Equal(t,204,code);require.True(t,next)}
 require.Equal(t,3,calls)
 for _,tc:=range []struct{body,ct string;code int}{
  {`{"image_urls":["https://evil.example/x"]}`,"application/json",403},
  {`{"images":[{"data_url":"data:image/png;base64,AAAA"}]}`,"application/json",400},
  {`{"image_urls":null}`,"application/json",400},
  {`{}`,"multipart/form-data; boundary=x",415},
  {strings.Repeat("x",65537),"application/json",413},
 }{code,next:=run("/v1/videos",tc.body,tc.ct,7);require.Equal(t,tc.code,code);require.False(t,next)}
 require.Equal(t,3,calls,"invalid references must never make an HTTP request")
 code,next:=run("/v1/videos",string(body),"application/json",8);require.Equal(t,403,code);require.False(t,next)
 http.DefaultTransport=piknoTestTransport(func(r *http.Request)(*http.Response,error){return &http.Response{StatusCode:404,Body:io.NopCloser(strings.NewReader(`{}`)),Header:make(http.Header)},nil})
 code,next=run("/v1/videos",string(body),"application/json",7);require.Equal(t,409,code);require.False(t,next)
 code,next=run("/v1/videos",`{"prompt":"text only"}`,"application/json",7);require.Equal(t,204,code);require.True(t,next)
 for _,body:=range []string{`{"model":"gpt-image-2.5-flare","prompt":"x","n":2}`,`{"model":"gpt-image-2.5-flare","prompt":"x","response_format":"b64_json"}`,`{"model":"gpt-image-2.5-flare","prompt":"x","image":"data:image/png;base64,AAAA"}`} {code,next=run("/v1/images/generations",body,"application/json",7);require.Equal(t,400,code);require.False(t,next)}
 code,next=run("/v1/images/generations",`{"model":"gpt-image-2.5-flare","prompt":"x","n":1}`,"application/json",7);require.Equal(t,204,code);require.True(t,next)
 code,next=run("/v1/images/edits",`{"model":"gpt-image-2.5-flare","prompt":"x"}`,"application/json",7);require.Equal(t,400,code);require.False(t,next)
}
