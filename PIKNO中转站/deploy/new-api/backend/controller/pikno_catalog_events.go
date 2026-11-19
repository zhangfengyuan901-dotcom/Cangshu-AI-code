package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

type piknoCatalogEventHub struct {
	mu        sync.Mutex
	listeners map[chan string]struct{}
	revision  string
	running   bool
}

var piknoCatalogEvents = &piknoCatalogEventHub{listeners: make(map[chan string]struct{})}

func (hub *piknoCatalogEventHub) subscribe() (chan string, bool) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if len(hub.listeners) >= 512 {
		return nil, false
	}
	listener := make(chan string, 1)
	hub.listeners[listener] = struct{}{}
	// Recompute on connection instead of sending a cached revision: the last
	// listener may have disconnected before a route changed.
	if !hub.running {
		hub.running = true
		go hub.run()
	}
	model.NotifyPiknoCatalogChange()
	return listener, true
}

func (hub *piknoCatalogEventHub) unsubscribe(listener chan string) {
	hub.mu.Lock()
	delete(hub.listeners, listener)
	hub.mu.Unlock()
	model.NotifyPiknoCatalogChange()
}

func (hub *piknoCatalogEventHub) publish(revision string) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	hub.revision = revision
	for listener := range hub.listeners {
		// Slow consumers receive the newest state, never an unbounded queue.
		select {
		case <-listener:
		default:
		}
		select {
		case listener <- revision:
		default:
		}
	}
}

func (hub *piknoCatalogEventHub) run() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		hub.mu.Lock()
		if len(hub.listeners) == 0 {
			hub.running = false
			hub.mu.Unlock()
			return
		}
		hub.mu.Unlock()
		if revision, err := model.PiknoCatalogChangeRevision(time.Now()); err == nil {
			hub.publish(revision)
		}
		select {
		case <-model.PiknoCatalogChangeWake():
		case <-ticker.C:
		}
	}
}

// Public notifications contain only a digest. Authentication and billing remain
// on the existing catalogue/task routes; no client credential is accepted here.
func PiknoCatalogEvents(c *gin.Context) {
	listener, ok := piknoCatalogEvents.subscribe()
	if !ok {
		c.Header("Retry-After", "30")
		c.AbortWithStatus(http.StatusTooManyRequests)
		return
	}
	defer piknoCatalogEvents.unsubscribe(listener)
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-store, no-transform")
	c.Header("X-Accel-Buffering", "no")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Status(http.StatusOK)
	_, _ = fmt.Fprint(c.Writer, "retry: 5000\n\n")
	c.Writer.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	last := ""
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case revision := <-listener:
			if revision == last {
				continue
			}
			last = revision
			data, _ := json.Marshal(struct {
				Revision string `json:"revision"`
			}{revision})
			if _, err := fmt.Fprintf(c.Writer, "event: catalog-change\ndata: %s\n\n", data); err != nil {
				return
			}
			c.Writer.Flush()
		case <-heartbeat.C:
			if _, err := fmt.Fprint(c.Writer, ": keepalive\n\n"); err != nil {
				return
			}
			c.Writer.Flush()
		}
	}
}
