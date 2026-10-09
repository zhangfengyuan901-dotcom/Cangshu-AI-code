package controller

import (
 "bytes"
 "crypto/hmac"
 "crypto/sha256"
 "encoding/base64"
 "encoding/hex"
 "encoding/json"
 "errors"
 "io"
 "mime"
 "net/http"
 "net/url"
 "os"
 "strings"
 "time"

 "github.com/gin-gonic/gin"
)

// Runs after account/token authentication and before channel selection or billing.
func PiknoMediaGuard(c *gin.Context) {
 path := c.Request.URL.Path
 video := path == "/v1/videos" || path == "/pikno-sanbao/tasks" || path == "/pikno-canseedream/tasks"
 image := path == "/v1/images/edits" || path == "/v1/images/generations"
 if c.Request.Method != http.MethodPost || (!video && !image) { c.Next(); return }
 reject := func(code int, message string) { c.AbortWithStatusJSON(code, gin.H{"error":gin.H{"message":message,"type":"invalid_media_reference"}}) }
 if c.GetInt("id") < 1 { reject(401,"Authentication required"); return }
 mediaType,_,err := mime.ParseMediaType(c.GetHeader("Content-Type"))
 if err != nil || mediaType != "application/json" { reject(415,"Use JSON with completed PIKNO media URLs"); return }
 raw,err := io.ReadAll(http.MaxBytesReader(c.Writer,c.Request.Body,64<<10))
 if err != nil { reject(413,"Video JSON exceeds 64 KiB"); return }
 c.Request.Body = io.NopCloser(bytes.NewReader(raw))
 var body map[string]json.RawMessage
 if json.Unmarshal(raw,&body) != nil || body == nil { reject(400,"Invalid JSON object"); return }
 if image {
  allowed:=map[string]bool{"model":true,"prompt":true,"n":true,"size":true,"quality":true,"response_format":true,"output_format":true,"images":true}
  for field:=range body { if !allowed[field] { reject(400,"Unsupported image field");return } }
  var model,prompt,format string;var n int
  if json.Unmarshal(body["model"],&model)!=nil || model!="gpt-image-2.5-flare" || json.Unmarshal(body["prompt"],&prompt)!=nil || strings.TrimSpace(prompt)=="" { reject(400,"Unsupported image model or empty prompt");return }
  if body["n"]!=nil && (json.Unmarshal(body["n"],&n)!=nil || n!=1) { reject(400,"n must be 1");return }
  if body["response_format"]!=nil && (json.Unmarshal(body["response_format"],&format)!=nil || format!="url") { reject(400,"response_format must be url");return }
  var refs []string
  if body["images"]!=nil && json.Unmarshal(body["images"],&refs)!=nil {reject(400,"images must contain completed PIKNO URLs");return}
  if (path=="/v1/images/edits" && (len(refs)<1 || len(refs)>5)) || (path=="/v1/images/generations" && len(refs)!=0) {reject(400,"Image edits require 1 to 5 references; generations require none");return}
 }
 count := 0
 for _,field := range []string{"image_urls","images","video_urls","videos","audio_urls","audios"} {
  value,exists := body[field]; if !exists { continue }
  var items []json.RawMessage
  if bytes.Equal(bytes.TrimSpace(value),[]byte("null")) || json.Unmarshal(value,&items) != nil { reject(400,"Reference media must be an array"); return }
  count += len(items); if count > 20 { reject(400,"Too many reference assets"); return }
  kind := strings.Split(field,"_")[0]; kind = strings.TrimSuffix(kind,"s")
  for _,item := range items {
   var reference string
   if json.Unmarshal(item,&reference) != nil {
    var object map[string]json.RawMessage
    if json.Unmarshal(item,&object) != nil || object["data_url"] != nil || json.Unmarshal(object["url"],&reference) != nil { reject(400,"Use completed PIKNO media URLs"); return }
   }
   p,err := piknoValidateMediaURL(reference,c.GetInt("id"),kind)
   if err != nil { reject(403,"Invalid, expired or foreign media reference; upload and complete the asset first"); return }
   if err := piknoInspectReference(c,p); err != nil { reject(409,"Reference asset is unavailable; upload and complete it again"); return }
  }
 }
 c.Next()
}

func piknoValidateMediaURL(raw string,uid int,kind string) (piknoMediaTicket,error) {
 var p piknoMediaTicket
 invalid := errors.New("invalid media reference")
 secret := os.Getenv("PIKNO_MEDIA_TICKET_KEY")
 if os.Getenv("PIKNO_MEDIA_ENABLED") != "true" || len(secret)<32 { return p,invalid }
 u,err := url.Parse(raw)
 if err != nil || u.Scheme!="https" || u.Host!="www.piknoai.com" || u.User!=nil || u.Fragment!="" || u.RawPath!="" { return p,invalid }
 q,err:=url.ParseQuery(u.RawQuery)
 if err!=nil || len(q)!=1 || len(q["ticket"])!=1 { return p,invalid }
 token:=q.Get("ticket"); if len(token)>2048 { return p,invalid }
 parts:=strings.Split(token,"."); if len(parts)!=2 { return p,invalid }
 sig,err:=base64.RawURLEncoding.DecodeString(parts[1]); if err!=nil { return p,invalid }
 mac:=hmac.New(sha256.New,[]byte(secret)); mac.Write([]byte(parts[0]))
 if !hmac.Equal(sig,mac.Sum(nil)) { return p,invalid }
 data,err:=base64.RawURLEncoding.DecodeString(parts[0]); if err!=nil || json.Unmarshal(data,&p)!=nil { return p,invalid }
 now:=time.Now().Unix(); id,err:=hex.DecodeString(p.ID)
 limits:=map[string]int64{"image/png":30<<20,"image/jpeg":30<<20,"image/webp":30<<20,"video/mp4":50<<20,"audio/mpeg":50<<20,"audio/wav":50<<20}
 if err!=nil || len(id)!=16 || u.Path!="/media/v1/assets/"+p.ID || p.Version!=1 || p.Audience!="pikno-relay-media" || p.Operation!="read" || p.UserID!=uid || uid<1 || p.Issued>now+30 || p.Expires<=now || p.Expires<=p.Issued || p.Expires-p.Issued>7200 || !strings.HasPrefix(p.MIME,kind+"/") || p.Size<12 || p.Size>limits[p.MIME] { return p,invalid }
 return p,nil
}

func piknoInspectReference(c *gin.Context,p piknoMediaTicket) error {
 p.Operation="inspect"; p.Issued=time.Now().Unix(); p.Expires=p.Issued+60
 token,err:=piknoSignMedia(p,os.Getenv("PIKNO_MEDIA_TICKET_KEY")); if err!=nil { return err }
 req,err:=http.NewRequestWithContext(c.Request.Context(),"POST","https://www.piknoai.com/media/v1/assets/"+p.ID+"/inspect",nil); if err!=nil { return err }
 req.Header.Set("Authorization","Bearer "+token)
 client:=&http.Client{Timeout:10*time.Second,CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}
 resp,err:=client.Do(req); if err!=nil { return errors.New("media inspection failed") }; defer resp.Body.Close()
 var result struct { ID string `json:"id"`; Owner int `json:"owner_id"`; Size int64 `json:"size"`; MIME string `json:"content_type"`; Status string `json:"status"` }
 if resp.StatusCode!=200 || json.NewDecoder(io.LimitReader(resp.Body,4096)).Decode(&result)!=nil || result.ID!=p.ID || result.Owner!=p.UserID || result.Size!=p.Size || result.MIME!=p.MIME || result.Status!="ready" { return errors.New("asset not ready") }
 return nil
}
