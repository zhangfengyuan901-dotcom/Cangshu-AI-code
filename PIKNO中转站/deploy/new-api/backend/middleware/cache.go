package middleware

import "github.com/gin-gonic/gin"

func Cache() func(c *gin.Context) {
	return func(c *gin.Context) {
		switch c.Request.URL.Path {
		case "/developer-guide.md", "/api-guide.md", "/examples/media-edit.mjs",
			"/auth-lite/index.html", "/auth-lite/auth.css", "/auth-lite/auth.mjs", "/auth-lite/client.mjs",
			"/auth-lite/local-challenge.mjs",
			"/account-lite/index.html", "/account-lite/account.css", "/account-lite/account.mjs", "/account-lite/client.mjs",
			"/account-lite/boot.js", "/account-lite/compat.mjs", "/account-lite/checkout-qr.mjs":
			// Public documentation and fixed-name account assets must receive
			// urgent updates without retaining an obsolete copy for a week.
			c.Header("Cache-Control", "no-store")
		default:
			if c.Request.RequestURI == "/" {
				c.Header("Cache-Control", "no-cache")
			} else {
				c.Header("Cache-Control", "max-age=604800")
			}
		}
		c.Header("Cache-Version", "b688f2fb5be447c25e5aa3bd063087a83db32a288bf6a4f35f2d8db310e40b14")
		c.Next()
	}
}
