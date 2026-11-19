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
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"time"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
)

type piknoImageFormBody struct {
	*os.File
	length int64
}

func (body *piknoImageFormBody) Size() int64                       { return body.length }
func (body *piknoImageFormBody) NewReader() (io.ReadCloser, error) { return os.Open(body.Name()) }
func (body *piknoImageFormBody) Close() error {
	name := body.Name()
	err := body.File.Close()
	_ = os.Remove(name)
	return err
}

// The validated file parts remain disk-backed while rebuilding the upstream
// multipart. Filenames sent upstream are fixed synthetic names.
func piknoDirectImageMultipart(c *gin.Context, model string) (io.ReadCloser, error) {
	form := c.Request.MultipartForm
	if form == nil {
		return nil, errors.New("direct image form unavailable")
	}
	file, err := os.CreateTemp("", "pikno-image-*.multipart")
	if err != nil {
		return nil, errors.New("direct image request unavailable")
	}
	body := &piknoImageFormBody{File: file}
	accepted := false
	defer func() {
		if !accepted {
			_ = body.Close()
		}
	}()
	writer := multipart.NewWriter(file)
	if err = writer.WriteField("model", model); err != nil {
		return nil, err
	}
	for field, values := range form.Value {
		if field == "model" || field == "response_format" {
			continue
		}
		if len(values) != 1 {
			return nil, errors.New("invalid image field")
		}
		if err = writer.WriteField(field, values[0]); err != nil {
			return nil, err
		}
	}
	files := form.File["image"]
	if len(files) == 0 {
		files = form.File["image[]"]
	}
	for index, reference := range files {
		contentType := reference.Header.Get("Content-Type")
		ext := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[contentType]
		if ext == "" {
			return nil, errors.New("invalid image type")
		}
		field := "image"
		if len(files) > 1 {
			field = "image[]"
		}
		headers := make(textproto.MIMEHeader)
		headers.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="reference-%d.%s"`, field, index, ext))
		headers.Set("Content-Type", contentType)
		part, writeErr := writer.CreatePart(headers)
		if writeErr != nil {
			return nil, writeErr
		}
		source, openErr := reference.Open()
		if openErr != nil {
			return nil, errors.New("image file unavailable")
		}
		count, copyErr := io.Copy(part, io.LimitReader(source, 30<<20+1))
		_ = source.Close()
		if copyErr != nil || count != reference.Size {
			return nil, errors.New("image file changed")
		}
	}
	if err = writer.Close(); err != nil {
		return nil, err
	}
	body.length, err = file.Seek(0, io.SeekCurrent)
	if err != nil {
		return nil, err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())
	accepted = true
	return body, nil
}

// Called by the existing image adaptor AFTER its normal quota reservation.
// Only small JSON crosses ECS; the Worker builds multipart from private R2.
func piknoPackyEdge(c *gin.Context, info *relaycommon.RelayInfo, body io.Reader) (any, error) {
	secret := os.Getenv("PIKNO_MEDIA_TICKET_KEY")
	if os.Getenv("PIKNO_MEDIA_ENABLED") != "true" || len(secret) < 32 {
		return nil, errors.New("media edge unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(body, 65537))
	if err != nil || len(data) > 65536 {
		return nil, errors.New("invalid image control payload")
	}
	requestID := c.GetString("pikno_edge_request_id")
	if requestID == "" {
		nonce := make([]byte, 16)
		if _, err = rand.Read(nonce); err != nil {
			return nil, err
		}
		requestID = hex.EncodeToString(nonce)
		c.Set("pikno_edge_request_id", requestID)
	}
	hash := sha256.Sum256(data)
	now := time.Now().Unix()
	claims := map[string]any{"v": 1, "aud": "pikno-packy-edge", "uid": c.GetInt("id"), "id": requestID, "iat": now, "exp": now + 60, "sha256": hex.EncodeToString(hash[:]), "path": c.Request.URL.Path}
	encoded, err := json.Marshal(claims)
	if err != nil {
		return nil, err
	}
	payload := base64.RawURLEncoding.EncodeToString(encoded)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	ticket := payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	req, err := http.NewRequestWithContext(c.Request.Context(), "POST", "https://www.piknoai.com/media/v1/packy", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+info.ApiKey)
	req.Header.Set("X-Pikno-Edge-Ticket", ticket)
	client := &http.Client{Timeout: 600 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("media edge request failed; check request history before retrying")
	}
	return resp, nil
}
