package router

import (
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func TestHamsterLiteExactHTML(t *testing.T) {
	gin.SetMode(gin.TestMode)
	files := fstest.MapFS{
		"web/dist/auth-lite/index.html":    &fstest.MapFile{Data: []byte("<h1>auth</h1>")},
		"web/dist/account-lite/index.html": &fstest.MapFile{Data: []byte("<h1>account</h1>")},
	}
	for _, path := range []string{"/auth-lite/index.html?mode=login", "/account-lite/index.html", "/account-lite/index.html?tab=keys"} {
		router := gin.New()
		router.NoRoute(middleware.Cache(), hamsterLiteHTML(files), func(c *gin.Context) { c.String(599, "unexpected fallback") })
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 200 || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Type") != "text/html; charset=utf-8" {
			t.Fatalf("%s: code=%d headers=%v", path, response.Code, response.Header())
		}
		if response.Body.Len() == 0 {
			t.Fatal("missing embedded HTML")
		}
	}
}

func TestHamsterLiteMissingHTMLFailsClosed(t *testing.T) {
	router := gin.New()
	router.NoRoute(hamsterLiteHTML(fstest.MapFS{}), func(c *gin.Context) { c.String(200, "unexpected app") })
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("GET", "/account-lite/index.html", nil))
	if response.Code != 500 {
		t.Fatalf("status=%d", response.Code)
	}
}

func TestHamsterLiteOtherRoutesRemainUnchanged(t *testing.T) {
	router := gin.New()
	router.NoRoute(hamsterLiteHTML(fstest.MapFS{}), func(c *gin.Context) { c.String(418, "original handler") })
	for _, path := range []string{"/api/user/self", "/static/js/app.js", "/sign-in", "/auth-lite/not-index.html"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 418 {
			t.Fatalf("%s: status=%d", path, response.Code)
		}
	}
}
