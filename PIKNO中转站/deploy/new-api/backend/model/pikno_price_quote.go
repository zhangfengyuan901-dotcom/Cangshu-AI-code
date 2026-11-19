package model

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrPiknoQuoteInvalid    = errors.New("quote_invalid")
	ErrPiknoQuoteExpired    = errors.New("quote_expired")
	ErrPiknoQuoteChanged    = errors.New("quote_changed")
	ErrPiknoQuoteParameters = errors.New("quote_parameters_changed")
	ErrPiknoQuoteUsed       = errors.New("quote_already_submitted")
)

var piknoNameCredential = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])(?:sk|ark)-[a-z0-9_-]{12,}`)

// Only customer-visible identities and non-content parameters enter the signed
// price context. It is not an authentication credential or generation permit.
type PiknoPriceParameters struct {
	Model           string `json:"model"`
	Operation       string `json:"operation"`
	Resolution      string `json:"resolution"`
	Quality         string `json:"quality"`
	Ratio           string `json:"ratio"`
	Seconds         int    `json:"seconds"`
	ReferenceImages int    `json:"reference_images"`
	ReferenceVideos int    `json:"reference_videos"`
	ReferenceAudio  int    `json:"reference_audio"`
	Quantity        int    `json:"quantity"`
}

type PiknoPriceContext struct {
	Version    int                  `json:"v"`
	UserID     int                  `json:"uid"`
	TokenID    int                  `json:"tid"`
	Issued     int64                `json:"iat"`
	Expires    int64                `json:"exp"`
	Nonce      string               `json:"nonce"`
	Revision   int64                `json:"revision"`
	Quota      int                  `json:"amount"`
	Parameters PiknoPriceParameters `json:"parameters"`
}

// Durable admission slots prevent concurrent/replayed quote submissions from
// reaching a second reservation or upstream call. Quote reads create no rows.
type PiknoPriceQuoteSlot struct {
	ID        string `gorm:"primaryKey;size:64"`
	UserID    int    `gorm:"not null"`
	TokenID   int    `gorm:"not null"`
	OrderID   string `gorm:"size:96;not null"`
	Expires   int64  `gorm:"not null;index"`
	CreatedAt int64  `gorm:"not null"`
}

func PiknoCNY(quota int) string {
	return fmt.Sprintf("%d.%06d", quota/1_000_000, quota%1_000_000)
}

func PiknoCustomerLineName(line *PiknoLineConfig) string {
	name := strings.TrimSpace(line.DisplayName)
	unsafe := name == "" || len([]rune(name)) > 160 || name == line.PublicModel
	lower := strings.ToLower(name)
	for _, text := range []string{"https://", "http://", "www.", "bearer "} {
		unsafe = unsafe || strings.Contains(lower, text)
	}
	unsafe = unsafe || piknoNameCredential.MatchString(name)
	for _, r := range name {
		unsafe = unsafe || unicode.IsControl(r) || r == '<' || r == '>'
	}
	if !unsafe {
		return name
	}
	if line.PublicModel == "pikno-tool-digital" {
		return "数字人"
	}
	if line.PublicModel == "pikno-tool-depth" {
		return "黑白深度视频"
	}
	if line.Kind == "image" {
		return "图片线路"
	}
	return "视频线路"
}

func SignPiknoPriceContext(context PiknoPriceContext) (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	context.Version, context.Nonce = 1, hex.EncodeToString(nonce)
	context.Issued = time.Now().Unix()
	context.Expires = context.Issued + 300
	raw, err := common.Marshal(context)
	if err != nil {
		return "", err
	}
	aead, err := piknoPriceAEAD()
	if err != nil {
		return "", err
	}
	iv := make([]byte, aead.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := aead.Seal(iv, iv, raw, []byte("pikno-price-quote-v1"))
	return "npq1." + base64.RawURLEncoding.EncodeToString(sealed), nil
}

// Encrypt as well as authenticate: opaque contexts must not expose account,
// credential-row or API routing identities to a desktop/browser decoder.
func piknoPriceAEAD() (cipher.AEAD, error) {
	mac := hmac.New(sha256.New, []byte(common.CryptoSecret))
	mac.Write([]byte("pikno-price-quote-aead-v1"))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Expiry is checked after looking up a used slot, so an expired replay is still
// reported as already submitted and cannot invite an automatic replacement.
func ParsePiknoPriceContext(token string) (*PiknoPriceContext, error) {
	if len(token) == 0 || len(token) > 4096 {
		return nil, ErrPiknoQuoteInvalid
	}
	payload, ok := strings.CutPrefix(token, "npq1.")
	if !ok {
		return nil, ErrPiknoQuoteInvalid
	}
	sealed, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, ErrPiknoQuoteInvalid
	}
	aead, err := piknoPriceAEAD()
	if err != nil || len(sealed) < aead.NonceSize()+aead.Overhead() {
		return nil, ErrPiknoQuoteInvalid
	}
	raw, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], []byte("pikno-price-quote-v1"))
	var context PiknoPriceContext
	if err != nil || common.Unmarshal(raw, &context) != nil || context.Version != 1 || context.UserID < 1 || context.TokenID < 1 || context.Revision < 1 || context.Quota < 0 || context.Quota > common.MaxQuota || context.Expires-context.Issued != 300 || context.Issued > time.Now().Unix()+30 || len(context.Nonce) != 32 {
		return nil, ErrPiknoQuoteInvalid
	}
	if _, err := hex.DecodeString(context.Nonce); err != nil {
		return nil, ErrPiknoQuoteInvalid
	}
	return &context, nil
}

func PiknoPriceSlotID(context *PiknoPriceContext, index int) (string, error) {
	if index < 0 || index >= context.Parameters.Quantity || (context.Parameters.Quantity != 1 && context.Parameters.Quantity != 2 && context.Parameters.Quantity != 4) {
		return "", ErrPiknoQuoteInvalid
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s:%d", context.Nonce, index)))), nil
}

func FindPiknoPriceSlot(id string) (*PiknoPriceQuoteSlot, error) {
	var slot PiknoPriceQuoteSlot
	err := DB.First(&slot, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &slot, err
}

func ClaimPiknoPriceSlot(context *PiknoPriceContext, index int) (*PiknoPriceQuoteSlot, error) {
	if context.Expires <= time.Now().Unix() {
		return nil, ErrPiknoQuoteExpired
	}
	id, err := PiknoPriceSlotID(context, index)
	if err != nil {
		return nil, err
	}
	slot := PiknoPriceQuoteSlot{ID: id, UserID: context.UserID, TokenID: context.TokenID, Expires: context.Expires, CreatedAt: time.Now().Unix()}
	result := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&slot)
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected != 1 {
		old, err := FindPiknoPriceSlot(id)
		if err != nil {
			return nil, err
		}
		return old, ErrPiknoQuoteUsed
	}
	return &slot, nil
}

// Called inside the same transaction as wallet reservation. Locking the line
// serializes a confirmed submission with publication; cached versions never
// authorize a changed price. Existing accepted orders keep their old snapshot.
func validatePiknoConfirmedReservation(tx *gorm.DB, q PiknoSettlementQuote, token *Token) error {
	if q.ConfirmedSlotID == "" {
		return nil
	}
	if q.ConfirmedExpires <= time.Now().Unix() {
		return ErrPiknoQuoteExpired
	}
	if q.ConfirmedRevision != q.LineRevision || q.ConfirmedQuota != q.QuoteQuota {
		return ErrPiknoQuoteChanged
	}
	var row PiknoLine
	if err := lockForUpdate(tx).First(&row, "public_model = ?", q.Model).Error; err != nil {
		return ErrPiknoQuoteChanged
	}
	line, err := decodePiknoLineConfig(row.PublishedConfig)
	if err != nil || line == nil || !line.Enabled || line.Revision != q.ConfirmedRevision || line.ChannelID != q.ChannelID {
		return ErrPiknoQuoteChanged
	}
	if PiknoSyncLineReadyTx(tx, line, time.Now().Unix()) != nil {
		return ErrPiknoQuoteChanged
	}
	group := "video-standard"
	if line.Kind == "image" {
		group = "image-standard"
	}
	if line.Provider == "hamster-tools" {
		group = "tool-standard"
	}
	if token.Group != group {
		return ErrPiknoQuoteInvalid
	}
	if token.ModelLimitsEnabled {
		limits := token.GetModelLimitsMap()
		if !limits[q.Model] && !limits[ratio_setting.RoutingMatchModelName(q.Model)] {
			return ErrPiknoQuoteInvalid
		}
	}
	var channel Channel
	if err := lockForUpdate(tx).First(&channel, q.ChannelID).Error; err != nil || channel.Status != common.ChannelStatusEnabled {
		return ErrPiknoQuoteChanged
	}
	var slot PiknoPriceQuoteSlot
	if err := lockForUpdate(tx).First(&slot, "id = ?", q.ConfirmedSlotID).Error; err != nil {
		return ErrPiknoQuoteInvalid
	}
	if slot.UserID != q.UserID || slot.TokenID != q.TokenID || slot.Expires != q.ConfirmedExpires {
		return ErrPiknoQuoteInvalid
	}
	if slot.OrderID != "" && slot.OrderID != q.OrderID {
		return ErrPiknoQuoteUsed
	}
	// Line/channel/slot locks can wait past expiry. Recheck after every blocking
	// lock, directly before slot binding and the wallet write in this transaction.
	if q.ConfirmedExpires <= time.Now().Unix() {
		return ErrPiknoQuoteExpired
	}
	return tx.Model(&slot).Update("order_id", q.OrderID).Error
}
