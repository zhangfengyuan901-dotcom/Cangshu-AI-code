package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// Exercise the global product boundary before the real authentication layer.
// A mounted handler alone does not prove that the production route is usable.
func TestPiknoPriceQuoteStorefrontRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(PiknoStorefrontGuard)
	router.POST("/v1/client/quote", middleware.TokenAuth(), PiknoPriceQuote)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/client/quote", strings.NewReader("{}"))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)
	require.Equal(t, http.StatusUnauthorized, response.Code)
	for _, tc := range []struct {
		path string
		code int
	}{
		{"/v1/client/quote/", http.StatusTemporaryRedirect},
		{"/v1/client/quote/extra", http.StatusNotFound},
		{"/v1/tasks/task_offline/artifacts", http.StatusNotFound},
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, tc.path, nil))
		require.Equal(t, tc.code, response.Code, tc.path)
	}
}
