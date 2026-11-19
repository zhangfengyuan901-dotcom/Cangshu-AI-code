package controller

import (
	"errors"
	"net/http"
	"os"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/piknocatalog"
	"github.com/gin-gonic/gin"
)

var catalogStore = piknocatalog.NewStore(catalogPath())

func catalogPath() string {
	if path := os.Getenv("PIKNO_CATALOG_PATH"); path != "" {
		return path
	}
	return "/data/pikno/catalog.json"
}
func catalogError(c *gin.Context, err error) {
	status := http.StatusServiceUnavailable
	if errors.Is(err, piknocatalog.ErrConflict) {
		status = http.StatusConflict
	}
	if errors.Is(err, piknocatalog.ErrBusy) {
		status = http.StatusTooManyRequests
	}
	c.JSON(status, gin.H{"success": false, "message": err.Error()})
}
func PiknoCatalog(c *gin.Context) {
	data, err := PiknoPublicLinesData()
	if err != nil {
		catalogError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"success": true, "data": data})
}
func PiknoCatalogAdmin(c *gin.Context) {
	state, err := catalogStore.Read()
	if err != nil {
		catalogError(c, err)
		return
	}
	c.JSON(200, gin.H{"success": true, "data": state, "changes": piknocatalog.Diff(state)})
}
func PiknoCatalogSync(c *gin.Context) {
	state, err := catalogStore.Sync(c.Request.Context(), c.GetInt("id"))
	if err != nil {
		catalogError(c, err)
		return
	}
	c.JSON(200, gin.H{"success": true, "data": state, "changes": piknocatalog.Diff(state)})
}
func PiknoCatalogPublish(c *gin.Context)  { catalogAction(c, false) }
func PiknoCatalogRollback(c *gin.Context) { catalogAction(c, true) }
func catalogAction(c *gin.Context, rollback bool) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2048)
	var body struct {
		Revision string `json:"revision"`
	}
	if common.DecodeJson(c.Request.Body, &body) != nil || len(body.Revision) > 64 || body.Revision == "" {
		c.JSON(400, gin.H{"success": false, "message": "Catalog revision required"})
		return
	}
	var state piknocatalog.State
	var err error
	if rollback {
		state, err = catalogStore.Rollback(body.Revision, c.GetInt("id"))
	} else {
		state, err = catalogStore.Publish(body.Revision, c.GetInt("id"))
	}
	if err != nil {
		catalogError(c, err)
		return
	}
	c.JSON(200, gin.H{"success": true, "data": state, "changes": piknocatalog.Diff(state)})
}
