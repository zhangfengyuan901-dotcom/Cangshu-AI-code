package service

import (
	"errors"
	"net/http"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"
)

const PiknoBalanceCheckHeader = "X-Pikno-Check-Balance"
const piknoWalletInsufficientCode types.ErrorCode = "insufficient_balance"

func piknoConfirmedPriceError(err error) *types.NewAPIError {
	for _, expected := range []error{model.ErrPiknoQuoteInvalid, model.ErrPiknoQuoteExpired, model.ErrPiknoQuoteChanged, model.ErrPiknoQuoteParameters, model.ErrPiknoQuoteUsed} {
		if errors.Is(err, expected) {
			return types.NewErrorWithStatusCode(expected, types.ErrorCode(expected.Error()), http.StatusConflict, types.ErrOptionWithSkipRetry())
		}
	}
	return nil
}
