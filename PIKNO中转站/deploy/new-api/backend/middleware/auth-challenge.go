package middleware

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"
)

const localChallengeCookie = "__Host-new_api_auth_challenge"
const localChallengeTTL = 120 * time.Second
const localChallengeNamespace = "authChallenge:v1:"

var localChallengeID = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var localChallengeAnswer = regexp.MustCompile(`^[0-9]{6}$`)

// GET + DEL is a single Redis operation on all supported Redis versions. A
// wrong answer consumes the challenge too. There is no outage fallback.
const consumeLocalChallenge = `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v`

func challengeFailure(c *gin.Context, status int) {
	c.Header("Cache-Control", "no-store")
	c.AbortWithStatusJSON(status, gin.H{"success": false, "code": "AUTH_CHALLENGE_FAILED", "message": "安全验证未完成，请重新验证。"})
}

func challengeContext(c *gin.Context) (context.Context, context.CancelFunc, *redis.Client, bool) {
	c.Header("Cache-Control", "no-store")
	c.Header("Referrer-Policy", "no-referrer")
	client, err := common.AuthChallengeRedisClient()
	if err != nil {
		challengeFailure(c, http.StatusServiceUnavailable)
		return nil, func() {}, nil, false
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	return ctx, cancel, client, true
}

// Keep issuance and image CPU bounded independently of the existing login and
// email budgets. Hash IPs in these ephemeral Redis keys; never store answers
// or usable tokens in logs.
func challengeBudget(c *gin.Context, ctx context.Context, client *redis.Client, action string) bool {
	for _, scope := range []struct {
		key   string
		limit int
	}{
		{"ip:" + challengeHash(c.ClientIP()), 20}, {"global", 300},
	} {
		// Reuse the fixed-window protocol, but never the application's RDB.
		values, err := client.Eval(ctx, redisFixedWindowScript, []string{localChallengeNamespace + "rate:" + action + ":" + scope.key}, scope.limit, 60).Slice()
		if err != nil || len(values) != 3 {
			challengeFailure(c, http.StatusServiceUnavailable)
			return false
		}
		allowed, allowedErr := redisReplyInteger(values[0])
		ttl, ttlErr := redisReplyInteger(values[2])
		if allowedErr != nil || ttlErr != nil || (allowed != 0 && allowed != 1) {
			challengeFailure(c, http.StatusServiceUnavailable)
			return false
		}
		if allowed == 0 {
			if ttl < 1 {
				ttl = 60
			}
			c.Header("Retry-After", strconv.FormatInt(ttl, 10))
			challengeFailure(c, http.StatusTooManyRequests)
			return false
		}
	}
	return true
}

func challengeHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func challengeRandomID() (string, error) {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value[:]), nil
}
func challengeBinding(c *gin.Context) string {
	value, err := c.Cookie(localChallengeCookie)
	if err != nil || !localChallengeID.MatchString(value) {
		return ""
	}
	return challengeHash(value)
}
func challengeKey(kind, binding, id string) string {
	// The binding is part of the key so a different browser cannot invalidate
	// another browser's challenge by submitting its public challenge ID.
	return localChallengeNamespace + "auth:" + kind + ":" + binding + ":" + id
}

func localChallengeOrigin(c *gin.Context) bool {
	origin, ok := requestBrowserOrigin(c.Request)
	if c.GetHeader("Sec-Fetch-Site") == "cross-site" || !ok || !isAllowedSessionOrigin(c.Request, origin) {
		challengeFailure(c, http.StatusForbidden)
		return false
	}
	return true
}

func IssueLocalAuthChallenge(c *gin.Context) {
	ctx, cancel, client, ok := challengeContext(c)
	defer cancel()
	if !ok {
		return
	}
	if !localChallengeOrigin(c) || !challengeBudget(c, ctx, client, "issue") {
		return
	}
	binding := challengeBinding(c)
	if binding == "" {
		cookie, err := challengeRandomID()
		if err != nil {
			challengeFailure(c, http.StatusServiceUnavailable)
			return
		}
		http.SetCookie(c.Writer, &http.Cookie{Name: localChallengeCookie, Value: cookie, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode})
		binding = challengeHash(cookie)
	}
	id, err := challengeRandomID()
	if err != nil {
		challengeFailure(c, http.StatusServiceUnavailable)
		return
	}
	answer := make([]byte, 6)
	for i := range answer {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			challengeFailure(c, http.StatusServiceUnavailable)
			return
		}
		answer[i] = byte('0' + n.Int64())
	}
	encoded, err := challengePNG(string(answer))
	if err != nil {
		challengeFailure(c, http.StatusServiceUnavailable)
		return
	}
	stored, err := client.SetNX(ctx, challengeKey("question", binding, id), challengeHash(string(answer)), localChallengeTTL).Result()
	if err != nil || !stored {
		challengeFailure(c, http.StatusServiceUnavailable)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"id": id, "image": "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded), "expires_in": int(localChallengeTTL.Seconds())}})
}

func VerifyLocalAuthChallenge(c *gin.Context) {
	ctx, cancel, client, ok := challengeContext(c)
	defer cancel()
	if !ok {
		return
	}
	if !localChallengeOrigin(c) || !challengeBudget(c, ctx, client, "answer") {
		return
	}
	// Enforce same-origin even when legacy insecure-development cookie mode is
	// enabled. The existing trusted origins cover TLS termination at Nginx.
	var request struct {
		ID     string `json:"id"`
		Answer string `json:"answer"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
	if common.DecodeJson(c.Request.Body, &request) != nil || !localChallengeID.MatchString(request.ID) {
		challengeFailure(c, http.StatusBadRequest)
		return
	}
	binding := challengeBinding(c)
	if binding == "" {
		challengeFailure(c, http.StatusBadRequest)
		return
	}
	expected, err := client.Eval(ctx, consumeLocalChallenge, []string{challengeKey("question", binding, request.ID)}).Text()
	if err != nil && err != redis.Nil {
		challengeFailure(c, http.StatusServiceUnavailable)
		return
	}
	if err == redis.Nil || !localChallengeAnswer.MatchString(request.Answer) || subtle.ConstantTimeCompare([]byte(expected), []byte(challengeHash(request.Answer))) != 1 {
		challengeFailure(c, http.StatusBadRequest)
		return
	}
	proof, err := challengeRandomID()
	if err != nil {
		challengeFailure(c, http.StatusServiceUnavailable)
		return
	}
	stored, err := client.SetNX(ctx, challengeKey("proof", binding, proof), "auth", localChallengeTTL).Result()
	if err != nil || !stored {
		challengeFailure(c, http.StatusServiceUnavailable)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"token": "local." + proof, "expires_in": int(localChallengeTTL.Seconds())}})
}

func checkLocalAuthProof(c *gin.Context) bool {
	// A solved challenge is scoped to these authentication operations. It must
	// never become a generic authorization token for unrelated Turnstile users.
	switch c.Request.Method + " " + c.Request.URL.Path {
	case "POST /api/user/login", "POST /api/user/register", "GET /api/verification", "GET /api/reset_password":
	default:
		challengeFailure(c, http.StatusForbidden)
		return false
	}
	ctx, cancel, client, ok := challengeContext(c)
	defer cancel()
	if !ok {
		return false
	}
	token := c.Query("turnstile")
	binding := challengeBinding(c)
	if len(token) != 49 || token[:6] != "local." || !localChallengeID.MatchString(token[6:]) || binding == "" {
		challengeFailure(c, http.StatusBadRequest)
		return false
	}
	value, err := client.Eval(ctx, consumeLocalChallenge, []string{challengeKey("proof", binding, token[6:])}).Text()
	if err != nil && err != redis.Nil {
		challengeFailure(c, http.StatusServiceUnavailable)
		return false
	}
	if err != nil || value != "auth" {
		challengeFailure(c, http.StatusBadRequest)
		return false
	}
	return true
}

// A small raster image avoids shipping the answer as SVG/text. This is an
// auxiliary automation hurdle, not a substitute for email proof or throttles.
func challengePNG(answer string) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, 210, 64))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{247, 247, 240, 255}}, image.Point{}, draw.Src)
	var noise [128]byte
	if _, err := rand.Read(noise[:]); err != nil {
		return nil, err
	}
	for i, digit := range answer {
		glyph := image.NewRGBA(image.Rect(0, 0, 8, 14))
		drawer := font.Drawer{Dst: glyph, Src: image.NewUniform(color.RGBA{45, 61, 51, 255}), Face: basicfont.Face7x13, Dot: fixed.P(0, 12)}
		drawer.DrawString(string(digit))
		x, y := 14+i*31+int(noise[i]%5), 10+int(noise[i+6]%9)
		for gy := 0; gy < 14; gy++ {
			for gx := 0; gx < 8; gx++ {
				pixel := glyph.RGBAAt(gx, gy)
				if pixel.A == 0 {
					continue
				}
				for dy := 0; dy < 3; dy++ {
					for dx := 0; dx < 3; dx++ {
						img.SetRGBA(x+gx*3+dx+int(noise[i+12]%3)*gy/7, y+gy*3+dy, pixel)
					}
				}
			}
		}
	}
	for i := 20; i+1 < len(noise); i += 2 {
		x, y := int(noise[i])%210, int(noise[i+1])%64
		img.SetRGBA(x, y, color.RGBA{115, 130, 110, 255})
	}
	var output bytes.Buffer
	err := png.Encode(&output, img)
	return output.Bytes(), err
}
