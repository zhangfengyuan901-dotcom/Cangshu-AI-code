import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import {
  SecureVerificationDialog,
  useSecureVerification,
} from '@/features/auth/secure-verification'
import { toIntlLocale } from '@/i18n/languages'
import { handleServerError } from '@/lib/handle-server-error'
import { AuthOperationError } from '@/lib/secure-verification'

import { parseSettlementCny, settlementCny, settlementLabels } from './amount'
import {
  applySettlement,
  previewSettlement,
  type AdminSettlement,
  type ReviewCommand,
  type ReviewPreview,
} from './api'

export function SettlementReview(props: {
  order: AdminSettlement
  onComplete: () => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const verification = useSecureVerification()
  const amount = z
    .string()
    .refine(
      (v) => Number.isSafeInteger(parseSettlementCny(v)),
      t('Enter a non-negative CNY amount with up to six decimal places.')
    )
  const schema = z
    .object({
      action: z.enum(['success', 'failure', 'waive', 'refund', 'acknowledge']),
      reason: z
        .string()
        .trim()
        .min(1, t('Review reason is required'))
        .max(2000),
      evidence_ref: z.string().trim().max(512),
      upstream_task_id: z.string().trim().max(128),
      images: z.string().regex(/^([1-9]|10)$/, t('Invalid image count')),
      charged: amount,
      refunded: amount,
      fixed_refund: amount,
    })
    .superRefine((v, ctx) => {
      if (
        v.action !== 'waive' &&
        v.action !== 'acknowledge' &&
        !v.evidence_ref
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_ref'],
          message: t('A private receipt reference is required'),
        })
      }
      if (
        v.action !== 'waive' &&
        v.action !== 'acknowledge' &&
        !v.upstream_task_id
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['upstream_task_id'],
          message: t('Enter the upstream task or receipt transaction ID'),
        })
      }
    })
  type Values = z.infer<typeof schema>
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      action: 'waive',
      reason: '',
      evidence_ref: '',
      upstream_task_id: props.order.upstream_task_id,
      images: '1',
      charged: (props.order.charged_quota / 1_000_000).toFixed(6),
      refunded: (props.order.upstream_refunded_quota / 1_000_000).toFixed(6),
      fixed_refund: (props.order.refunded_quota / 1_000_000).toFixed(6),
    },
  })
  const [pending, setPending] = useState<{
    command: ReviewCommand
    preview: ReviewPreview
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const action = form.watch('action')
  const fields = [
    {
      name: 'upstream_task_id',
      label: 'Upstream task or receipt transaction ID',
    },
    { name: 'evidence_ref', label: 'Private receipt reference (no API keys)' },
    { name: 'charged', label: 'Confirmed upstream debit (CNY)' },
    { name: 'refunded', label: 'Cumulative upstream refund (CNY)' },
    { name: 'images', label: 'Confirmed image count' },
    {
      name: 'fixed_refund',
      label: 'Cumulative customer refund (CNY)',
    },
  ] as const
  const preview = form.handleSubmit(async (values) => {
    const command: ReviewCommand = {
      operation_id: crypto.randomUUID(),
      version: props.order.version,
      action: values.action,
      reason: values.reason,
      evidence_ref: values.evidence_ref,
      upstream_task_id: values.upstream_task_id,
      images: Number(values.images),
      charged_quota: parseSettlementCny(values.charged),
      refunded_quota: parseSettlementCny(values.refunded),
      fixed_refund_quota: parseSettlementCny(values.fixed_refund),
    }
    try {
      setPending({
        command,
        preview: await previewSettlement(props.order.order_id, command),
      })
    } catch (error) {
      handleServerError(error)
      props.onComplete()
    }
  })
  const confirm = async () => {
    if (!pending || busy) return
    const snapshot = pending
    setBusy(true)
    try {
      const proof = await verification.requestVerification({
        scope: 'pikno.settlement.review',
        context: { digest: snapshot.preview.digest },
        title: t('Verify settlement review'),
        description: `${props.order.order_id} · ${t(settlementLabels[snapshot.command.action])} · ${t('Net consumption')}: ${settlementCny(snapshot.preview.after_net, locale)}`,
      })
      if (!proof) return
      await applySettlement(
        props.order.order_id,
        snapshot.command,
        proof.proof_token
      )
      toast.success(t('Settlement review recorded'))
    } catch (error) {
      handleServerError(AuthOperationError.from(error))
    } finally {
      setBusy(false)
      setPending(null)
      props.onComplete()
    }
  }
  return (
    <>
      <form onSubmit={preview}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor='review-action'>
              {t('Review action')}
            </FieldLabel>
            <NativeSelect
              id='review-action'
              {...form.register('action')}
              disabled={busy}
            >
              {(
                [
                  'waive',
                  'success',
                  'failure',
                  'refund',
                  'acknowledge',
                ] as const
              ).map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {t(settlementLabels[value])}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {action !== 'waive' &&
            action !== 'acknowledge' &&
            fields
              .filter((field) => {
                if (field.name === 'images') {
                  return (
                    props.order.price_mode === 'flare_fixed' &&
                    action === 'success'
                  )
                }
                if (field.name === 'fixed_refund') {
                  return (
                    props.order.price_mode === 'flare_fixed' &&
                    action === 'refund'
                  )
                }
                if (field.name === 'charged' || field.name === 'refunded') {
                  return (
                    props.order.price_mode !== 'video_success_quote' ||
                    action === 'refund'
                  )
                }
                return true
              })
              .map((field) => (
                <Field
                  key={field.name}
                  data-invalid={!!form.formState.errors[field.name]}
                >
                  <FieldLabel htmlFor={`review-${field.name}`}>
                    {t(field.label)}
                  </FieldLabel>
                  <Input
                    id={`review-${field.name}`}
                    {...form.register(field.name)}
                    disabled={busy}
                    aria-invalid={!!form.formState.errors[field.name]}
                  />
                  <FieldError>
                    {form.formState.errors[field.name]?.message}
                  </FieldError>
                </Field>
              ))}
          <Field data-invalid={!!form.formState.errors.reason}>
            <FieldLabel htmlFor='review-reason'>
              {t('Review reason')}
            </FieldLabel>
            <Textarea
              id='review-reason'
              {...form.register('reason')}
              maxLength={2000}
              disabled={busy}
              aria-invalid={!!form.formState.errors.reason}
            />
            <FieldError>{form.formState.errors.reason?.message}</FieldError>
          </Field>
          <Button type='submit' disabled={busy || form.formState.isSubmitting}>
            {t('Preview settlement difference')}
          </Button>
        </FieldGroup>
      </form>
      <ConfirmDialog
        open={!!pending && !verification.isActive}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null)
        }}
        title={t('Confirm settlement difference')}
        desc={
          pending ? (
            <span className='flex flex-col gap-2'>
              <span>
                {props.order.order_id} ·{' '}
                {t(settlementLabels[pending.command.action])}
              </span>
              <span>
                {t('Reserved funds')}:{' '}
                {settlementCny(pending.preview.before_reserved, locale)} →{' '}
                {settlementCny(pending.preview.after_reserved, locale)}
              </span>
              <span>
                {t('Net consumption')}:{' '}
                {settlementCny(pending.preview.before_net, locale)} →{' '}
                {settlementCny(pending.preview.after_net, locale)}
              </span>
              <span>
                {t('Available balance change')}:{' '}
                {settlementCny(pending.preview.wallet_delta, locale)}
              </span>
              {pending.preview.review_required && (
                <span>{t('This action leaves the order pending review.')}</span>
              )}
            </span>
          ) : (
            ''
          )
        }
        confirmText={t('Verify and submit')}
        handleConfirm={confirm}
        isLoading={busy}
      />
      <SecureVerificationDialog {...verification.dialogProps} />
    </>
  )
}
