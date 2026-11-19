package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestPiknoPublicDocumentCache(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.NoRoute(Cache(), func(c *gin.Context) { c.Status(http.StatusOK) })
	for _, path := range []string{"/developer-guide.md", "/api-guide.md", "/examples/media-edit.mjs"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			for _, query := range []string{"", "?v=client34"} {
				t.Run(method+" "+path+query, func(t *testing.T) {
					response := httptest.NewRecorder()
					router.ServeHTTP(response, httptest.NewRequest(method, path+query, nil))
					require.Equal(t, http.StatusOK, response.Code)
					require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
				})
			}
		}
	}
	for _, tc := range []struct{ path, expected string }{
		{"/", "no-cache"},
		{"/assets/app.js", "max-age=604800"},
		{"/unrelated.md", "max-age=604800"},
	} {
		t.Run(tc.path+" unchanged", func(t *testing.T) {
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, tc.path, nil))
			require.Equal(t, tc.expected, response.Header().Get("Cache-Control"))
		})
	}
}
