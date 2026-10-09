package model

import (
	"errors"
	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// Claim serializes senders without holding a transaction open during network IO.
// Stop uncertain retries before the provider's 24-hour idempotency window ends.
func ClaimPiknoSettlementMail(id, now int64) (*PiknoSettlementOutbox,error) {
	var claimed *PiknoSettlementOutbox
	err:=DB.Transaction(func(tx *gorm.DB)error{
		var item PiknoSettlementOutbox
		if err:=lockForUpdate(tx).First(&item,id).Error; err!=nil{return err}
		if item.DeliveredAt!=0 || item.LeaseUntil>now || item.NextAttemptAt>now || item.DeliveryState=="manual_review" {return nil}
		if item.FirstAttemptAt!=0 && now-item.FirstAttemptAt>=23*3600 {
			return tx.Model(&item).Update("delivery_state","manual_review").Error
		}
		if item.Recipient=="" {
			var user User
			if err:=tx.First(&user,item.UserID).Error;err!=nil{
				if !errors.Is(err,gorm.ErrRecordNotFound) { return err }
				return tx.Model(&item).Update("delivery_state","manual_review").Error
			}
			if common.Validate.Var(user.Email,"required,email")!=nil{return tx.Model(&item).Update("delivery_state","manual_review").Error}
			item.Recipient=user.Email
		}
		if item.FirstAttemptAt==0 {item.FirstAttemptAt=now}
		item.LeaseToken=common.GetRandomString(32);item.LeaseUntil=now+60;item.Attempts++;item.DeliveryState="sending"
		if err:=tx.Save(&item).Error;err!=nil{return err};claimed=&item;return nil
	})
	return claimed,err
}

// Freeze the complete provider request before making any network call. A
// deployment or sender-setting change cannot mutate an uncertain retry.
func FreezePiknoSettlementMail(item *PiknoSettlementOutbox, payload string) error {
	if item.DeliveryPayload!="" {return nil}
	result:=DB.Model(&PiknoSettlementOutbox{}).Where("id = ? AND lease_token = ? AND delivered_at = 0",item.ID,item.LeaseToken).Update("delivery_payload",payload)
	if result.Error!=nil{return result.Error};if result.RowsAffected!=1{return ErrPiknoConflict}
	item.DeliveryPayload=payload;return nil
}

func FinishPiknoSettlementMail(item *PiknoSettlementOutbox,now int64,sent bool) error {
	values:=map[string]any{"lease_until":0,"lease_token":"","delivery_state":"retry","next_attempt_at":now+min(int64(60*item.Attempts*item.Attempts),int64(3600))}
	if sent {values["delivered_at"]=now;values["delivery_state"]="sent"}
	result:=DB.Model(&PiknoSettlementOutbox{}).Where("id = ? AND lease_token = ? AND delivered_at = 0",item.ID,item.LeaseToken).Updates(values)
	if result.Error!=nil{return result.Error};if result.RowsAffected!=1{return ErrPiknoConflict};return nil
}
