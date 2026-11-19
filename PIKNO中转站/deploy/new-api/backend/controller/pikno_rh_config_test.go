package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type piknoRHTestTransport func(*http.Request) (*http.Response, error)

func (transport piknoRHTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

// TestPiknoRHConfigHTTP exercises the production authentication middleware and
// the controller together. The transport is in-memory: it never reaches RH,
// Cloudflare, or any paid workflow.
func TestPiknoRHConfigHTTP(t *testing.T) {
	root, _ := setupSecurityEnrollmentTest(t)
	require.NoError(t, model.DB.Model(root).Update("role", common.RoleRootUser).Error)
	require.NoError(t, model.PublishUserAuthCache(root.Id))
	require.NoError(t, model.LOG_DB.AutoMigrate(&model.Log{}))

	rootBundle, err := service.CreateLoginSession(root.Id, "password", "127.0.0.1", "rh-root")
	require.NoError(t, err)
	rootIdentity, err := service.ParseAccessToken(rootBundle.AccessToken)
	require.NoError(t, err)

	customer := &model.User{
		Username:    "rh-customer",
		Password:    root.Password,
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
		AffCode:     "rh-customer-aff",
	}
	require.NoError(t, model.DB.Create(customer).Error)
	require.NoError(t, model.PublishUserAuthCache(customer.Id))
	customerBundle, err := service.CreateLoginSession(customer.Id, "password", "127.0.0.1", "rh-customer")
	require.NoError(t, err)
	administrator := &model.User{
		Username:    "rh-administrator",
		Password:    root.Password,
		Role:        common.RoleAdminUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
		AffCode:     "rh-administrator-aff",
	}
	require.NoError(t, model.DB.Create(administrator).Error)
	require.NoError(t, model.PublishUserAuthCache(administrator.Id))
	administratorBundle, err := service.CreateLoginSession(administrator.Id, "password", "127.0.0.1", "rh-administrator")
	require.NoError(t, err)
	personalAccessToken, _ := createScopedAccessToken(t, root.Id, 0, "profile:read")

	const (
		adminSecret = "tools-admin-test-secret-32-characters"
		rhKey       = "rh_test_123456789012345678901234"
		otherRHKey  = "rh_test_543210987654321098765432"
		version     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	)
	t.Setenv("PIKNO_TOOLS_ADMIN_SECRET", adminSecret)

	type cloudRequest struct {
		Method        string
		URL           string
		Authorization string
		ContentType   string
		Origin        string
		Body          string
	}
	requests := make([]cloudRequest, 0, 3)
	previousTransport := piknoRHTransport
	piknoRHTransport = piknoRHTestTransport(func(request *http.Request) (*http.Response, error) {
		data, readErr := io.ReadAll(request.Body)
		require.NoError(t, readErr)
		requests = append(requests, cloudRequest{
			Method:        request.Method,
			URL:           request.URL.String(),
			Authorization: request.Header.Get("Authorization"),
			ContentType:   request.Header.Get("Content-Type"),
			Origin:        request.Header.Get("Origin"),
			Body:          string(data),
		})
		responseBody := `{"configured":false,"enabled":true,"ready":false,"version":"","updated_at":"","storage":"cloud-encrypted","api_key":"` + rhKey + `"}`
		if request.Method == http.MethodPost {
			responseBody = `{"configured":true,"enabled":true,"ready":true,"version":"` + version + `","updated_at":"2026-10-13T00:00:00.000Z","storage":"cloud-encrypted","authorization_valid":true,"api_key":"` + rhKey + `"}`
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(responseBody)),
		}, nil
	})
	t.Cleanup(func() { piknoRHTransport = previousTransport })

	router := gin.New()
	routes := router.Group(piknoRHConfigRoute, middleware.RootAuth(), middleware.DisableCache())
	routes.GET("", PiknoRHConfig)
	routes.POST("", PiknoRHConfig)
	routes.POST("/check", PiknoRHConfig)
	request := func(method, path, credential, body, proof, origin string) *httptest.ResponseRecorder {
		httpRequest := httptest.NewRequest(method, path, strings.NewReader(body))
		httpRequest.Header.Set("Authorization", "Bearer "+credential)
		httpRequest.Header.Set("Content-Type", "application/json")
		if proof != "" {
			httpRequest.Header.Set("X-Security-Proof", proof)
		}
		if origin != "" {
			httpRequest.Header.Set("Origin", origin)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httpRequest)
		return response
	}
	bodyFor := func(key string) string {
		payload, marshalErr := common.Marshal(map[string]string{"api_key": key, "expected_version": ""})
		require.NoError(t, marshalErr)
		return string(payload)
	}
	proofFor := func(key string) string {
		digest := sha256.Sum256([]byte(key))
		context, marshalErr := common.Marshal(service.PiknoRHConfigureContext{
			KeyHash:         hex.EncodeToString(digest[:]),
			ExpectedVersion: "",
		})
		require.NoError(t, marshalErr)
		return issueSecurityEnrollmentProof(t, rootIdentity, service.VerificationOperation{
			Scope:   service.VerificationScopePiknoRHConfigure,
			Context: context,
		}, service.VerificationMethodPassword)
	}

	t.Run("GET returns an allowlisted status without the cloud credential", func(t *testing.T) {
		response := request(http.MethodGet, piknoRHConfigRoute, rootBundle.AccessToken, "", "", "")
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), `"storage":"cloud-encrypted"`)
		assert.NotContains(t, response.Body.String(), rhKey)
		assert.NotContains(t, response.Body.String(), "api_key")
		require.Len(t, requests, 1)
		assert.Equal(t, piknoRHCloudOrigin+piknoRHCloudConfigPath, requests[0].URL)
		assert.Equal(t, "Bearer "+adminSecret, requests[0].Authorization)
	})

	t.Run("non-root sessions and personal access tokens cannot reach the cloud service", func(t *testing.T) {
		customerResponse := request(http.MethodGet, piknoRHConfigRoute, customerBundle.AccessToken, "", "", "")
		assert.Equal(t, http.StatusForbidden, customerResponse.Code)
		administratorResponse := request(http.MethodGet, piknoRHConfigRoute, administratorBundle.AccessToken, "", "", "")
		assert.Equal(t, http.StatusForbidden, administratorResponse.Code)
		patResponse := request(http.MethodGet, piknoRHConfigRoute, personalAccessToken, "", "", "")
		assert.Equal(t, http.StatusForbidden, patResponse.Code)
		assert.Len(t, requests, 1)
	})

	validProof := proofFor(rhKey)
	t.Run("cross-origin and missing proofs fail before forwarding", func(t *testing.T) {
		crossOrigin := request(http.MethodPost, piknoRHConfigRoute, rootBundle.AccessToken, bodyFor(rhKey), validProof, "https://evil.example")
		assert.Equal(t, http.StatusForbidden, crossOrigin.Code)
		missingProof := request(http.MethodPost, piknoRHConfigRoute, rootBundle.AccessToken, bodyFor(rhKey), "", piknoRHCloudOrigin)
		assert.Equal(t, http.StatusForbidden, missingProof.Code)
		assert.Len(t, requests, 1)
	})

	t.Run("proof context cannot be replayed with another key", func(t *testing.T) {
		wrongContext := request(http.MethodPost, piknoRHConfigRoute, rootBundle.AccessToken, bodyFor(otherRHKey), proofFor(rhKey), piknoRHCloudOrigin)
		assert.Equal(t, http.StatusForbidden, wrongContext.Code)
		assert.Contains(t, wrongContext.Body.String(), "SECURITY_PROOF_CONTEXT_MISMATCH")
		assert.Len(t, requests, 1)
	})

	t.Run("matching proof forwards once to the fixed cloud URL without persistence", func(t *testing.T) {
		response := request(http.MethodPost, piknoRHConfigRoute, rootBundle.AccessToken, bodyFor(rhKey), validProof, piknoRHCloudOrigin)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		assert.NotContains(t, response.Body.String(), rhKey)
		assert.NotContains(t, response.Body.String(), adminSecret)
		require.Len(t, requests, 2)
		forwarded := requests[1]
		assert.Equal(t, http.MethodPost, forwarded.Method)
		assert.Equal(t, piknoRHCloudOrigin+piknoRHCloudConfigPath, forwarded.URL)
		assert.Equal(t, "Bearer "+adminSecret, forwarded.Authorization)
		assert.Equal(t, "application/json", forwarded.ContentType)
		assert.Empty(t, forwarded.Origin, "browser headers must not be forwarded")
		var payload map[string]string
		require.NoError(t, common.Unmarshal([]byte(forwarded.Body), &payload))
		assert.Equal(t, map[string]string{"api_key": rhKey, "expected_version": ""}, payload)

		var logs []model.Log
		require.NoError(t, model.LOG_DB.Find(&logs).Error)
		stored, marshalErr := common.Marshal(logs)
		require.NoError(t, marshalErr)
		assert.NotContains(t, string(stored), rhKey)
		assert.NotContains(t, string(stored), adminSecret)
		var audits []model.AuditLog
		require.NoError(t, model.LOG_DB.Find(&audits).Error)
		stored, marshalErr = common.Marshal(audits)
		require.NoError(t, marshalErr)
		assert.NotContains(t, string(stored), rhKey)
		assert.NotContains(t, string(stored), adminSecret)
	})

	t.Run("read-only authorization check uses its fixed endpoint and no key body", func(t *testing.T) {
		response := request(http.MethodPost, piknoRHConfigCheckRoute, rootBundle.AccessToken, "", "", piknoRHCloudOrigin)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		require.Len(t, requests, 3)
		assert.Equal(t, piknoRHCloudOrigin+piknoRHCloudConfigPath+"/check", requests[2].URL)
		assert.Empty(t, requests[2].Body)
		assert.NotContains(t, response.Body.String(), rhKey)
	})
}
