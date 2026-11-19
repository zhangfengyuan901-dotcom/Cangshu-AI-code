package common

import (
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
)

const LocalAuthChallengeProvider = "local-image"

var authChallengeRedis struct {
	sync.Mutex
	url    string
	client *redis.Client
}

// Authentication storage is independent of the application's Redis switch.
// In particular, enabling it must not change synchronous accounting or the
// existing global/session/login limiters. A missing or invalid URL has no
// fallback to the application's Redis client or to process-local storage.
func AuthChallengeRedisClient() (*redis.Client, error) {
	if AuthChallengeProvider() != LocalAuthChallengeProvider {
		return nil, errors.New("local authentication storage is disabled")
	}
	url := strings.TrimSpace(os.Getenv("AUTH_CHALLENGE_REDIS_URL"))
	if url == "" {
		return nil, errors.New("local authentication storage is not configured")
	}
	authChallengeRedis.Lock()
	defer authChallengeRedis.Unlock()
	if authChallengeRedis.client != nil && authChallengeRedis.url == url {
		return authChallengeRedis.client, nil
	}
	options, err := redis.ParseURL(url)
	if err != nil {
		// Parse errors can contain credentials from the URL.
		return nil, errors.New("local authentication storage configuration is invalid")
	}
	options.MaxRetries = -1 // Unknown writes must never be replayed automatically.
	options.DialTimeout = 2 * time.Second
	options.ReadTimeout = 2 * time.Second
	options.WriteTimeout = 2 * time.Second
	options.PoolTimeout = 2 * time.Second
	options.PoolSize = 8
	options.MinIdleConns = 0
	if authChallengeRedis.client != nil {
		_ = authChallengeRedis.client.Close()
	}
	authChallengeRedis.client = redis.NewClient(options)
	authChallengeRedis.url = url
	return authChallengeRedis.client, nil
}

// This server-owned switch cannot be changed by an anonymous request or by
// disabling the historical Turnstile option. Unknown providers fail closed.
func AuthChallengeProvider() string {
	provider := strings.TrimSpace(os.Getenv("AUTH_CHALLENGE_PROVIDER"))
	if provider == "" {
		return "turnstile"
	}
	return provider
}

func AuthChallengePublicSettings() (bool, string) {
	if AuthChallengeProvider() != "turnstile" {
		return true, LocalAuthChallengeProvider
	}
	return TurnstileCheckEnabled, TurnstileSiteKey
}
