package controller

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
)

var piknoAssistantTransport http.RoundTripper = http.DefaultTransport
var piknoAssistantFilePath = regexp.MustCompile(`^/api/v3/files/[A-Za-z0-9_-]{1,256}$`)
var piknoAssistantSessionFormat = regexp.MustCompile(`^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$`)

// Inference is the existing unbilled helper service, not a generic chat relay.
// The shared inference key remains exclusively in the protected Worker.
func PiknoAssistantActivate(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	secret := os.Getenv("PIKNO_ASSISTANT_BRIDGE_SECRET")
	if os.Getenv("PIKNO_ASSISTANT_ENABLED") != "true" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Assistant unavailable", "code": "assistant_disabled"})
		return
	}
	if len(secret) < 32 {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Assistant unavailable"})
		return
	}
	uid, tokenID := c.GetInt("id"), c.GetInt("token_id")
	group := common.GetContextKeyString(c, constant.ContextKeyTokenGroup)
	if uid < 1 || tokenID < 1 || (group != "image-standard" && group != "video-standard") {
		c.JSON(http.StatusForbidden, gin.H{"error": "Use an image or video key"})
		return
	}
	now := time.Now().Unix()
	subject := sha256.Sum256([]byte(fmt.Sprintf("%d:%d", uid, tokenID)))
	claims, err := common.Marshal(gin.H{"v": 1, "aud": "hamster-pikno-activation", "uid": uid, "sub": hex.EncodeToString(subject[:]), "iat": now, "exp": now + 60})
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Assistant unavailable"})
		return
	}
	payload := base64.RawURLEncoding.EncodeToString(claims)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	ticket := payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, "https://inference.hamsterai.cc/internal/pikno/activate", nil)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Assistant unavailable"})
		return
	}
	req.Header.Set("Authorization", "Bearer "+ticket)
	client := &http.Client{Transport: piknoAssistantTransport, Timeout: 20*time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Assistant unavailable"})
		return
	}
	defer resp.Body.Close()
	var session struct {
		Token string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
	}
	if resp.StatusCode == http.StatusOK && common.DecodeJson(io.LimitReader(resp.Body, 4096), &session) == nil {
		expires, parseErr := time.Parse(time.RFC3339Nano, session.ExpiresAt)
		if parseErr == nil && expires.After(time.Now()) && expires.Before(time.Now().Add(16*time.Minute)) && len(session.Token) < 2048 && piknoAssistantSessionFormat.MatchString("Bearer "+session.Token) {
			c.JSON(http.StatusOK, gin.H{"token": session.Token, "expiresAt": session.ExpiresAt})
			return
		}
	}
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Assistant unavailable"})
}

func PiknoAssistantProxy(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	if os.Getenv("PIKNO_ASSISTANT_ENABLED") != "true" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Assistant unavailable"})
		return
	}
	path := strings.TrimPrefix(c.Request.URL.Path, "/assistant")
	method := c.Request.Method
	allowed := method == http.MethodPost && (path == "/api/v3/responses" || path == "/api/v3/files")
	allowed = allowed || ((method == http.MethodGet || method == http.MethodDelete) && piknoAssistantFilePath.MatchString(path))
	if !allowed || c.Request.URL.RawQuery != "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Assistant operation not available"})
		return
	}
	auth := c.GetHeader("Authorization")
	if len(auth) > 2048 || !piknoAssistantSessionFormat.MatchString(auth) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Assistant session required"})
		return
	}
	limit := int64(50 << 20)
	if path == "/api/v3/responses" { limit = 2 << 20 }
	if c.Request.ContentLength > limit {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Request too large"})
		return
	}
	var body io.Reader
	if method == http.MethodPost { body = http.MaxBytesReader(c.Writer, c.Request.Body, limit) }
	req, err := http.NewRequestWithContext(c.Request.Context(), method, "https://inference.hamsterai.cc"+path, body)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Assistant unavailable"})
		return
	}
	for _, name := range []string{"Content-Type", "Accept", "Range"} { req.Header.Set(name, c.GetHeader(name)) }
	req.Header.Set("Authorization", auth)
	req.Header.Set("X-Hamster-Client", "hamster-desktop-v1")
	client := &http.Client{Transport: piknoAssistantTransport, Timeout: 660*time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Assistant unavailable"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		status := resp.StatusCode
		if status < 400 || status > 599 { status = http.StatusBadGateway }
		c.JSON(status, gin.H{"error": gin.H{"code": "assistant_unavailable", "message": "仓鼠智能服务请求未完成，请稍后重试"}})
		return
	}
	for _, name := range []string{"Content-Type", "Content-Range", "Accept-Ranges"} { c.Header(name, resp.Header.Get(name)) }
	c.Status(resp.StatusCode)
	buffer := make([]byte, 32<<10)
	for {
		n, readErr := resp.Body.Read(buffer)
		if n > 0 { if _, err = c.Writer.Write(buffer[:n]); err != nil { return }; c.Writer.Flush() }
		if readErr != nil { return }
	}
}
