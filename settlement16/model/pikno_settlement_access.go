package model

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

func AuthorizePiknoReviewer(id int) error {
	if id <= 0 { return ErrPiknoPermission }
	var user User
	if DB.First(&user,id).Error != nil || user.Username != "piknoadmin" || user.Role != common.RoleRootUser || user.Status != common.UserStatusEnabled { return ErrPiknoPermission }
	return nil
}

type PiknoReviewPreview struct {
	OrderID string `json:"order_id"`
	Version int `json:"version"`
	Digest string `json:"digest"`
	BeforeReserved int `json:"before_reserved"`
	BeforeNet int `json:"before_net"`
	AfterReserved int `json:"after_reserved"`
	AfterNet int `json:"after_net"`
	WalletDelta int `json:"wallet_delta"`
	State string `json:"state"`
	ReviewRequired bool `json:"review_required"`
}

func PreviewPiknoSettlement(c PiknoSettlementCommand) (*PiknoReviewPreview,error) {
	if err:=AuthorizePiknoReviewer(c.ActorID); err!=nil { return nil,err }
	if c.Action!="success" && c.Action!="failure" && c.Action!="waive" && c.Action!="refund" && c.Action!="acknowledge" { return nil,errors.New("invalid review action") }
	if !validPiknoReference(c.OperationID,96) || c.OperationID=="reserve" || strings.TrimSpace(c.Reason)=="" || len(c.Reason)>2000 { return nil,errors.New("invalid review details") }
	var s PiknoSettlement
	if err:=DB.First(&s,"id = ?",c.OrderID).Error; err!=nil { return nil,err }
	if s.Version!=c.ExpectedVersion { return nil,ErrPiknoConflict }
	preview:=PiknoReviewPreview{OrderID:s.ID,Version:s.Version,BeforeReserved:s.ReservedQuota,BeforeNet:s.NetQuota}
	if err:=s.decide(c); err!=nil { return nil,err }
	preview.AfterReserved,preview.AfterNet,preview.State,preview.ReviewRequired=s.ReservedQuota,s.NetQuota,s.FinancialState,s.ReviewReason!=""
	preview.WalletDelta=preview.BeforeReserved+preview.BeforeNet-preview.AfterReserved-preview.AfterNet
	encoded,err:=common.Marshal(c); if err!=nil { return nil,err }
	preview.Digest=fmt.Sprintf("%x",sha256.Sum256(encoded))
	return &preview,nil
}

type PiknoSettlementAdminView struct {
	PiknoSettlementView
	UserID int `json:"user_id"`
	Model string `json:"model"`
	PriceMode string `json:"price_mode"`
	QuoteQuota int `json:"quote_quota"`
	AccountRef string `json:"account_ref"`
	UpstreamTaskID string `json:"upstream_task_id"`
	NetCostQuota int `json:"net_cost_quota"`
	ChargedQuota int `json:"charged_quota"`
	UpstreamRefundedQuota int `json:"upstream_refunded_quota"`
	ReviewReason string `json:"review_reason"`
	ReviewDueAt int64 `json:"review_due_at"`
	CreatedAt int64 `json:"created_at"`
}

func (s PiknoSettlement) AdminView() PiknoSettlementAdminView {
	return PiknoSettlementAdminView{s.CustomerView(),s.UserID,s.Model,s.PriceMode,s.QuoteQuota,s.AccountRef,s.UpstreamTaskID,s.NetCostQuota,s.UpstreamChargedQuota,s.UpstreamRefundedQuota,s.ReviewReason,s.ReviewDueAt,s.CreatedAt}
}

type PiknoLedgerView struct {
	ID int64 `json:"id"`
	OrderID string `json:"order_id"`
	Action string `json:"action"`
	WalletDelta int `json:"wallet_delta"`
	NetQuota int `json:"net_quota"`
	ReservedQuota int `json:"reserved_quota"`
	FinancialState string `json:"financial_state"`
	CreatedAt int64 `json:"created_at"`
}

type PiknoLedgerAdminView struct {
	PiknoLedgerView
	ActorID int `json:"actor_id"`
	Reason string `json:"reason"`
	Evidence string `json:"evidence"`
}

func (e PiknoSettlementEvent) CustomerView() PiknoLedgerView {
	return PiknoLedgerView{e.ID,e.OrderID,e.Action,e.WalletDelta,e.NetQuota,e.ReservedQuota,e.FinancialState,e.CreatedAt}
}

// Ownership is enforced here as well as in the HTTP router. UserID is always
// taken from the authenticated session; zero never means "all customers".
func GetPiknoCustomerSettlement(userID int, orderID string) (*PiknoSettlement,[]PiknoLedgerView,error) {
	if userID<=0 { return nil,nil,gorm.ErrRecordNotFound }
	var s PiknoSettlement
	if err:=DB.Where("id = ? AND user_id = ?",orderID,userID).First(&s).Error; err!=nil { return nil,nil,err }
	var events []PiknoSettlementEvent
	if err:=DB.Where("order_id = ? AND action <> ?",orderID,"reminder").Order("id").Find(&events).Error; err!=nil { return nil,nil,err }
	views:=make([]PiknoLedgerView,0,len(events))
	for _,e:=range events { views=append(views,e.CustomerView()) }
	return &s,views,nil
}
