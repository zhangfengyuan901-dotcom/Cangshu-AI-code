package controller

// Control plane only: file bodies are uploaded to Cloudflare, never to this handler.
import (
 "crypto/hmac"
 "crypto/rand"
 "crypto/sha256"
 "encoding/base64"
 "encoding/hex"
 "io"
 "net/http"
 "os"
 "strings"
 "time"

 "github.com/QuantumNous/new-api/common"
 "github.com/gin-gonic/gin"
)

type piknoMediaTicket struct {
 Version int `json:"v"`
 Audience string `json:"aud"`
 UserID int `json:"uid"`
 ID string `json:"id"`
 Operation string `json:"op"`
 Issued int64 `json:"iat"`
 Expires int64 `json:"exp"`
 MIME string `json:"mime"`
 Size int64 `json:"size"`
}

func piknoSignMedia(p piknoMediaTicket, secret string) (string, error) {
 data, err := common.Marshal(p)
 if err != nil { return "", err }
 payload := base64.RawURLEncoding.EncodeToString(data)
 mac := hmac.New(sha256.New, []byte(secret)); mac.Write([]byte(payload))
 return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func PiknoMediaUpload(c *gin.Context) {
 c.Header("Cache-Control", "no-store")
 secret := os.Getenv("PIKNO_MEDIA_TICKET_KEY")
 if os.Getenv("PIKNO_MEDIA_ENABLED") != "true" || len(secret) < 32 { c.JSON(503, gin.H{"error":"Media upload unavailable"}); return }
 if c.GetInt("id") < 1 { c.JSON(401, gin.H{"error":"Authentication required"}); return }
 c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
 var input struct { MIME string `json:"content_type"`; Size int64 `json:"size"` }
 if common.DecodeJson(c.Request.Body, &input) != nil { c.JSON(400, gin.H{"error":"Invalid JSON"}); return }
 limits := map[string]int64{"image/png":30<<20, "image/jpeg":30<<20, "image/webp":30<<20, "video/mp4":50<<20, "video/webm":50<<20, "video/quicktime":50<<20, "audio/mpeg":50<<20, "audio/wav":50<<20, "audio/mp4":50<<20, "audio/aac":50<<20}
 if input.Size < 12 || input.Size > limits[input.MIME] { c.JSON(400, gin.H{"error":"Unsupported media type or size"}); return }
 nonce := make([]byte, 16)
 if _, err := rand.Read(nonce); err != nil { c.JSON(500, gin.H{"error":"Cannot issue upload ticket"}); return }
 now := time.Now().Unix()
 p := piknoMediaTicket{1,"pikno-relay-media",c.GetInt("id"),hex.EncodeToString(nonce),"upload",now,now+600,input.MIME,input.Size}
 token, err := piknoSignMedia(p,secret)
 if err != nil { c.JSON(500, gin.H{"error":"Cannot issue upload ticket"}); return }
 c.JSON(201,gin.H{"id":p.ID,"upload_url":"https://www.piknoai.com/media/v1/assets/"+p.ID,"method":"PUT","headers":gin.H{"Authorization":"Bearer "+token,"Content-Type":p.MIME},"upload_ticket":token,"expires_at":p.Expires})
}

func PiknoMediaComplete(c *gin.Context) {
 c.Header("Cache-Control", "no-store")
 secret := os.Getenv("PIKNO_MEDIA_TICKET_KEY")
 if os.Getenv("PIKNO_MEDIA_ENABLED") != "true" || len(secret) < 32 { c.JSON(503,gin.H{"error":"Media upload unavailable"}); return }
 c.Request.Body = http.MaxBytesReader(c.Writer,c.Request.Body,4096)
 var input struct { Ticket string `json:"upload_ticket"` }
 if common.DecodeJson(c.Request.Body,&input) != nil { c.JSON(400,gin.H{"error":"Invalid JSON"}); return }
 parts := strings.Split(input.Ticket,".")
 if len(parts)!=2 { c.JSON(403,gin.H{"error":"Invalid upload ticket"}); return }
 mac := hmac.New(sha256.New,[]byte(secret)); mac.Write([]byte(parts[0]))
 signature,err := base64.RawURLEncoding.DecodeString(parts[1])
 if err!=nil || !hmac.Equal(signature,mac.Sum(nil)) { c.JSON(403,gin.H{"error":"Invalid upload ticket"}); return }
 data,err := base64.RawURLEncoding.DecodeString(parts[0]); var p piknoMediaTicket
 now := time.Now().Unix()
 if err!=nil || common.Unmarshal(data,&p)!=nil || p.UserID<1 || p.UserID!=c.GetInt("id") || p.Version!=1 || p.Audience!="pikno-relay-media" || p.Operation!="upload" || p.Expires<=now { c.JSON(403,gin.H{"error":"Expired or foreign upload ticket"}); return }
 idBytes,err := hex.DecodeString(p.ID)
 if err!=nil || len(idBytes)!=16 { c.JSON(403,gin.H{"error":"Invalid asset ID"}); return }
 p.Operation="inspect"; p.Issued=now; p.Expires=now+60
 inspectToken,err := piknoSignMedia(p,secret)
 if err!=nil { c.JSON(500,gin.H{"error":"Media verification failed"}); return }
 target := "https://www.piknoai.com/media/v1/assets/"+p.ID
 req,err := http.NewRequestWithContext(c.Request.Context(),"POST",target+"/inspect",nil)
 if err!=nil { c.JSON(500,gin.H{"error":"Media verification failed"}); return }
 req.Header.Set("Authorization","Bearer "+inspectToken)
 client := &http.Client{Timeout:10*time.Second,CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}
 resp,err := client.Do(req)
 if err!=nil { c.JSON(502,gin.H{"error":"Media verification unavailable"}); return }; defer resp.Body.Close()
 var result struct { Status string `json:"status"`; Owner int `json:"owner_id"`; ID string `json:"id"`; Size int64 `json:"size"`; MIME string `json:"content_type"` }
 if resp.StatusCode!=200 || common.DecodeJson(io.LimitReader(resp.Body,4096),&result)!=nil || result.Status!="ready" || result.Owner!=p.UserID || result.ID!=p.ID || result.Size!=p.Size || result.MIME!=p.MIME { c.JSON(409,gin.H{"error":"Asset not ready"}); return }
 p.Operation="read"; p.Expires=now+7200
 readToken,err := piknoSignMedia(p,secret)
 if err!=nil { c.JSON(500,gin.H{"error":"Media verification failed"}); return }
 c.JSON(200,gin.H{"id":p.ID,"status":"ready","url":target+"?ticket="+readToken,"expires_at":p.Expires})
}
