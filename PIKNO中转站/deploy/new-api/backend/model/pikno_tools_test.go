package model

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestPiknoToolsQuoteExpiresWhileWaitingForLineLock(t *testing.T) {
	driver := os.Getenv("PIKNO_SETTLEMENT_TEST_DRIVER")
	if driver != "mysql" && driver != "postgres" {
		t.Skip("real row-lock wait requires MySQL or PostgreSQL; SQLite expiry is covered by the HTTP contract test")
	}
	openPiknoLineTestDB(t)
	require.NoError(t, DB.AutoMigrate(&User{}, &Token{}))
	require.NoError(t, MigratePiknoSettlements(DB))
	user := User{Username: "quote-expiry-lock", AffCode: "expirylock", Password: "test-only", Status: common.UserStatusEnabled, Quota: 1_000_000}
	require.NoError(t, DB.Create(&user).Error)
	token := Token{UserId: user.Id, Key: "expiry-lock-test-only", Group: "image-standard", Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
	require.NoError(t, DB.Create(&token).Error)
	channel := Channel{Name: "quote-expiry-lock", Key: "test-only", Status: common.ChannelStatusEnabled, Type: constant.ChannelTypeOpenAI}
	require.NoError(t, channel.Insert())
	line := PiknoLineConfig{PublicModel: "pikno-image-expiry-lock", DisplayName: "Expiry lock test", Kind: "image", Provider: "packy", UpstreamModel: "gpt-image-2", ChannelID: channel.Id, Enabled: true, UpstreamAvailable: true, Revision: 1, Prices: []PiknoLinePrice{{Resolution: "default", Unit: "image", RetailQuota: 100000}}}
	raw, err := encodePiknoLineConfig(&line)
	require.NoError(t, err)
	require.NoError(t, DB.Create(&PiknoLine{PublicModel: line.PublicModel, Version: 1, PublishedConfig: raw}).Error)
	t.Cleanup(func() {
		require.NoError(t, DB.Where("user_id = ?", user.Id).Delete(&PiknoPriceQuoteSlot{}).Error)
		require.NoError(t, DB.Where("user_id = ?", user.Id).Delete(&PiknoSettlement{}).Error)
		require.NoError(t, DB.Where("public_model = ?", line.PublicModel).Delete(&PiknoLine{}).Error)
		require.NoError(t, DB.Where("channel_id = ?", channel.Id).Delete(&Ability{}).Error)
		require.NoError(t, DB.Unscoped().Delete(&channel).Error)
		require.NoError(t, DB.Unscoped().Delete(&token).Error)
		require.NoError(t, DB.Unscoped().Delete(&user).Error)
	})
	holder := DB.Begin()
	require.NoError(t, holder.Error)
	defer holder.Rollback()
	var held PiknoLine
	require.NoError(t, lockForUpdate(holder).First(&held, "public_model = ?", line.PublicModel).Error)
	arrived := make(chan struct{})
	var once sync.Once
	callback := "quote-expiry-lock-boundary"
	require.NoError(t, DB.Callback().Query().Before("gorm:query").Register(callback, func(tx *gorm.DB) {
		if tx.Statement.Table == "pikno_lines" {
			once.Do(func() { close(arrived) })
		}
	}))
	t.Cleanup(func() { require.NoError(t, DB.Callback().Query().Remove(callback)) })
	expires := time.Now().Unix() + 3
	slot := PiknoPriceQuoteSlot{ID: strings.Repeat("f", 64), UserID: user.Id, TokenID: token.Id, Expires: expires, CreatedAt: time.Now().Unix()}
	require.NoError(t, DB.Create(&slot).Error)
	q := PiknoSettlementQuote{OrderID: "quote-expiry-lock-order", UserID: user.Id, TokenID: token.Id, ChannelID: channel.Id, Model: line.PublicModel, LineRevision: 1, LineProvider: "packy", PriceUnit: "image", AccountRef: "test-only", PriceMode: "line_success_quote", RequestedImages: 1, QuoteQuota: 100000, ConfirmedSlotID: slot.ID, ConfirmedRevision: 1, ConfirmedQuota: 100000, ConfirmedExpires: expires}
	result := make(chan error, 1)
	go func() { _, err := ReservePiknoSettlement(q); result <- err }()
	select {
	case <-arrived:
	case err := <-result:
		t.Fatalf("reservation failed before the held line query: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("reservation did not reach the held line query")
	}
	// The callback fires only after the entry expiry check. The SELECT itself
	// remains blocked by holder until the confirmed quote is now expired.
	time.Sleep(time.Until(time.Unix(expires, 0).Add(100 * time.Millisecond)))
	require.NoError(t, holder.Commit().Error)
	select {
	case err := <-result:
		require.ErrorIs(t, err, ErrPiknoQuoteExpired)
	case <-time.After(10 * time.Second):
		t.Fatal("reservation did not finish after releasing the line lock")
	}
	require.NoError(t, DB.First(&user, user.Id).Error)
	assert.Equal(t, 1_000_000, user.Quota)
	var count int64
	require.NoError(t, DB.Model(&PiknoSettlement{}).Where("id = ?", q.OrderID).Count(&count).Error)
	assert.Zero(t, count)
	require.NoError(t, DB.First(&slot, "id = ?", slot.ID).Error)
	assert.Empty(t, slot.OrderID)
}

func TestPiknoTools(t *testing.T) {
	openPiknoLineTestDB(t)
	require.NoError(t, DB.AutoMigrate(&User{}, &Token{}, &Task{}))
	require.NoError(t, MigratePiknoSettlements(DB))
	require.NoError(t, MigratePiknoSettlements(DB))
	previousRegistry := jsplugin.DefaultRegistry
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	t.Cleanup(func() {
		require.NoError(t, jsplugin.DefaultRegistry.Unregister("pikno-tools"))
		jsplugin.DefaultRegistry = previousRegistry
	})
	source, err := os.ReadFile("/build/pikno-tools.js")
	require.NoError(t, err)
	_, err = jsplugin.DefaultRegistry.Register(string(source), jsplugin.Options{Key: "pikno-tools", Version: "candidate"})
	require.NoError(t, err)
	baseURL := "https://www.piknoai.com"
	setting := `{"task_plugin_key":"pikno-tools"}`
	channel := Channel{Type: constant.ChannelTypeTaskPlugin, Key: "test-only", Name: "depth-test", Models: "depth", Status: common.ChannelStatusEnabled, BaseURL: &baseURL, Setting: &setting}
	require.NoError(t, channel.Insert())
	line := PiknoLineConfig{PublicModel: "pikno-tool-depth", DisplayName: "Depth", Kind: "video", Provider: "hamster-tools", PluginKey: "pikno-tools", UpstreamModel: "depth", ChannelID: channel.Id, Enabled: true, UpstreamAvailable: true, ExplicitFree: true, Revision: 1, Prices: []PiknoLinePrice{{Resolution: "default", Unit: "request", RetailQuota: 0}}}
	t.Cleanup(func() {
		require.NoError(t, DB.Unscoped().Where("channel_id = ?", channel.Id).Delete(&Ability{}).Error)
		require.NoError(t, DB.Unscoped().Delete(&channel).Error)
		require.NoError(t, DB.Unscoped().Where("public_model = ?", line.PublicModel).Delete(&PiknoLine{}).Error)
	})
	raw, err := encodePiknoLineConfig(&line)
	require.NoError(t, err)
	require.NoError(t, DB.Create(&PiknoLine{PublicModel: line.PublicModel, Version: 1, PublishedConfig: raw}).Error)
	invalidatePiknoLineCache()
	quote, err := QuotePublishedPiknoLine(line.PublicModel, channel.Id, PiknoLineUsage{Requests: 1})
	require.NoError(t, err)
	require.Zero(t, quote.Quota)
	for _, mutate := range []func(*PiknoLineConfig){func(c *PiknoLineConfig) { c.ExplicitFree = false }, func(c *PiknoLineConfig) { c.PublicModel = "pikno-tool-digital" }, func(c *PiknoLineConfig) { c.Provider = "sanbao" }, func(c *PiknoLineConfig) { c.ReferenceSurchargeQuota = 1 }} {
		copy := line
		mutate(&copy)
		require.False(t, PiknoLineAllowsZeroQuote(&copy))
	}
	legacy, err := decodePiknoLineConfig(`{"public_model":"pikno-video-legacy"}`)
	require.NoError(t, err)
	require.False(t, legacy.ExplicitFree)
	user := User{Username: "tool_free", AffCode: "toolfree", Password: "test-only", Status: common.UserStatusEnabled}
	require.NoError(t, DB.Create(&user).Error)
	token := Token{UserId: user.Id, Key: "free-tool-test-only", Status: common.TokenStatusEnabled, ExpiredTime: -1}
	require.NoError(t, DB.Create(&token).Error)
	q := PiknoSettlementQuote{OrderID: "task_free", UserID: user.Id, TokenID: token.Id, ChannelID: channel.Id, Model: line.PublicModel, PriceMode: "line_success_quote", LineProvider: line.Provider, LineRevision: 1, PriceUnit: "request", AccountRef: "test-only", QuoteQuota: 0}
	order, err := ReservePiknoSettlement(q)
	require.NoError(t, err)
	require.Zero(t, order.ReservedQuota)
	_, err = ReservePiknoSettlement(q)
	require.NoError(t, err)
	event, err := ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "unknown", ExpectedVersion: 1, Action: "observe", Outcome: "unknown"})
	require.NoError(t, err)
	require.Equal(t, "pending_review", event.FinancialState)
	prices := []PiknoLinePrice{{Resolution: "default", Unit: "request", RetailQuota: 500_000}}
	view, err := UpdatePiknoLineDraft(line.PublicModel, PiknoLinePatch{ExpectedVersion: 1, Prices: &prices}, 1)
	require.NoError(t, err)
	require.NotNil(t, view.Draft)
	require.NotNil(t, view.Published)
	assert.False(t, view.Draft.ExplicitFree)
	assert.Equal(t, 500_000, view.Draft.Prices[0].RetailQuota)
	assert.True(t, view.CanPublish, view.BlockingReasons)
	assert.True(t, view.Published.ExplicitFree)
	assert.Zero(t, view.Published.Prices[0].RetailQuota)
	for range 2 {
		seed := line
		seed.Prices = []PiknoLinePrice{{Resolution: "default", Unit: "request", RetailQuota: 0}}
		require.NoError(t, SyncPiknoLines([]PiknoLineSeed{seed}, 1))
		view, err = GetPiknoLineAdmin(line.PublicModel, 0)
		require.NoError(t, err)
		assert.False(t, view.Draft.ExplicitFree)
		assert.Equal(t, 500_000, view.Draft.Prices[0].RetailQuota)
		assert.True(t, view.CanPublish, view.BlockingReasons)
		assert.True(t, view.Published.ExplicitFree)
		assert.Zero(t, view.Published.Prices[0].RetailQuota)
	}
	view, err = PublishPiknoLine(line.PublicModel, view.Version, 1)
	require.NoError(t, err)
	pricedQuote, err := QuotePublishedPiknoLine(line.PublicModel, channel.Id, PiknoLineUsage{Requests: 1})
	require.NoError(t, err)
	assert.Equal(t, 500_000, pricedQuote.Quota)
	assert.False(t, view.Published.ExplicitFree)
	require.NotNil(t, view.Previous)
	assert.True(t, view.Previous.ExplicitFree)
	assert.Zero(t, view.Previous.Prices[0].RetailQuota)
	assert.Zero(t, quote.Quota, "previously accepted free quote must remain unchanged")
	command := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "success", ExpectedVersion: event.Version, Action: "observe", Outcome: "succeeded"}
	_, err = ApplyPiknoSettlement(command)
	require.NoError(t, err)
	_, err = ApplyPiknoSettlement(command)
	require.NoError(t, err)
	require.NoError(t, DB.First(&user, user.Id).Error)
	require.Zero(t, user.Quota)
	require.Zero(t, user.UsedQuota)
	require.Equal(t, 1, user.RequestCount)
	for _, model := range []string{"pikno-tool-digital", "pikno-video-unpriced"} {
		invalid := q
		invalid.OrderID = "rejected-" + model
		invalid.Model = model
		_, err = ReservePiknoSettlement(invalid)
		require.Error(t, err)
	}
	var persisted PiknoSettlement
	require.NoError(t, DB.First(&persisted, "id = ?", q.OrderID).Error)
	require.Equal(t, "settled", persisted.FinancialState)
	require.Zero(t, persisted.NetQuota)
	assert.Zero(t, persisted.QuoteQuota)
	assert.EqualValues(t, 1, persisted.LineRevision, "repricing must not replace the old order snapshot")
}

func TestPiknoToolsDedicatedChannels(t *testing.T) {
	openPiknoLineTestDB(t)
	previousRegistry := jsplugin.DefaultRegistry
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	t.Cleanup(func() { jsplugin.DefaultRegistry = previousRegistry })
	source, err := os.ReadFile("/build/pikno-tools.js")
	require.NoError(t, err)
	_, err = jsplugin.DefaultRegistry.Register(string(source), jsplugin.Options{Key: "pikno-tools", Version: "candidate"})
	require.NoError(t, err)
	baseURL, setting := "https://www.piknoai.com", `{"task_plugin_key":"pikno-tools"}`
	shared := Channel{Type: constant.ChannelTypeTaskPlugin, Key: "test-only", Name: "historical-shared", Models: "digital,depth", BaseURL: &baseURL, Setting: &setting, Status: common.ChannelStatusEnabled, Group: "video-standard"}
	require.NoError(t, shared.Insert())
	for _, kind := range []string{"digital", "depth"} {
		quota := 500_000
		if kind == "digital" {
			quota = 5_000_000
		}
		line := PiknoLineConfig{PublicModel: "pikno-tool-" + kind, DisplayName: kind, Kind: "video", Provider: "hamster-tools", PluginKey: "pikno-tools", UpstreamModel: kind, Enabled: true, UpstreamAvailable: true, Prices: []PiknoLinePrice{{Resolution: "default", Unit: "request", RetailQuota: quota}}}
		assert.Zero(t, RecommendPiknoChannel(line), "the historical shared connection cannot accept new tool lines")
		channel := Channel{Type: constant.ChannelTypeTaskPlugin, Key: "test-only", Name: kind + "-dedicated", Models: kind, BaseURL: &baseURL, Setting: &setting, Status: common.ChannelStatusEnabled}
		require.NoError(t, channel.Insert())
		line.ChannelID = RecommendPiknoChannel(line)
		require.Equal(t, channel.Id, line.ChannelID)
		require.NoError(t, SyncPiknoLines([]PiknoLineSeed{line}, 1))
		view, err := PublishPiknoLine(line.PublicModel, 1, 1)
		require.NoError(t, err)
		assert.Equal(t, channel.Id, view.Published.ChannelID)
		require.NoError(t, DB.First(&channel, channel.Id).Error)
		assert.Equal(t, "tool-standard", channel.Group)
		assert.Equal(t, channel.Id, RecommendPiknoChannel(line), "published aliases retain deterministic binding")
		quote, err := QuotePublishedPiknoLine(line.PublicModel, channel.Id, PiknoLineUsage{Requests: 1})
		require.NoError(t, err)
		assert.Equal(t, quota, quote.Quota)
	}
	tools, err := EnabledPiknoLineModelsForGroups([]string{"tool-standard"})
	require.NoError(t, err)
	assert.True(t, tools["pikno-tool-digital"])
	assert.True(t, tools["pikno-tool-depth"])
	video, err := EnabledPiknoLineModelsForGroups([]string{"video-standard"})
	require.NoError(t, err)
	assert.False(t, video["pikno-tool-digital"])
	assert.False(t, video["pikno-tool-depth"])
	require.NoError(t, DB.First(&shared, shared.Id).Error)
	assert.Equal(t, "video-standard", shared.Group, "historical connection remains available for accepted tasks")
	assert.Equal(t, "digital,depth", shared.Models)
}
