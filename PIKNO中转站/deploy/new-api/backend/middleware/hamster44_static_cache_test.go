package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestHamster44FixedAccountAssetsDoNotCache(t *testing.T) {
	server := gin.New()
	server.Use(Cache())
	server.NoRoute(func(c *gin.Context) { c.Status(http.StatusOK) })
	checks := []struct{ path, expected string }{
		{"/auth-lite/index.html", "no-store"},
		{"/auth-lite/index.html?mode=login", "no-store"},
		{"/auth-lite/auth.css", "no-store"},
		{"/auth-lite/auth.mjs", "no-store"},
		{"/auth-lite/client.mjs", "no-store"},
		{"/auth-lite/local-challenge.mjs", "no-store"},
		{"/auth-lite/local-challenge.mjs?v=55", "no-store"},
		{"/account-lite/index.html", "no-store"},
		{"/account-lite/index.html?tab=keys", "no-store"},
		{"/account-lite/account.css", "no-store"},
		{"/account-lite/account.mjs", "no-store"},
		{"/account-lite/client.mjs", "no-store"},
		{"/account-lite/boot.js", "no-store"},
		{"/account-lite/boot.js?v=49", "no-store"},
		{"/account-lite/compat.mjs", "no-store"},
		{"/account-lite/checkout-qr.mjs", "no-store"},
		{"/developer-guide.md", "no-store"},
		{"/api-guide.md", "no-store"},
		{"/examples/media-edit.mjs", "no-store"},
		{"/", "no-cache"},
		{"/index.html", "max-age=604800"},
		{"/static/js/index.abc123.js", "max-age=604800"},
		{"/auth-lite/other.mjs", "max-age=604800"},
		{"/account-lite-other/index.html", "max-age=604800"},
	}
	for _, check := range checks {
		t.Run(check.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, check.path, nil))
			if got := response.Header().Get("Cache-Control"); got != check.expected {
				t.Fatalf("Cache-Control = %q, expected %q", got, check.expected)
			}
			if response.Header().Get("Cache-Version") == "" {
				t.Fatal("Existing cache version header was removed")
			}
		})
	}
}
