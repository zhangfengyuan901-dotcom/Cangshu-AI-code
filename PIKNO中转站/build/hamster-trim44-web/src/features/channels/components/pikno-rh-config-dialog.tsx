import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { Dialog } from '@/components/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  SecureVerificationDialog,
  useSecureVerification,
} from '@/features/auth/secure-verification'
import { api } from '@/lib/api'
import {
  AuthOperationError,
  authRequestOptions,
  authResult,
} from '@/lib/secure-verification'

type RHStatus = {
  configured: boolean
  enabled: boolean
  ready: boolean
  version: string
  updated_at: string
  authorization_valid?: boolean
}

const schema = z.object({
  api_key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/, 'Enter the 32-character RH Key'),
})

type Values = z.infer<typeof schema>
type Props = { open: boolean; onOpenChange: (open: boolean) => void }

function keyHash(value: string) {
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(value))
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')
    )
}

export function PiknoRHConfigDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const verification = useSecureVerification()
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { api_key: '' },
  })
  const { reset: resetForm } = form
  const status = useQuery({
    queryKey: ['pikno-rh-config'],
    enabled: open,
    queryFn: () => authResult<RHStatus>(api.get('/api/pikno/rh-config')),
    retry: false,
    meta: { errorToast: false },
  })
  const save = useMutation({
    // Deliberately accept no mutation variables. React Query must never retain
    // the real RH Key in its mutation cache or devtools state.
    mutationFn: async () => {
      try {
        if (!status.data) {
          throw new Error('RH status is not loaded')
        }
        const apiKey = form.getValues('api_key')
        const expectedVersion = status.data.version
        const proof = await verification.requestVerification({
          scope: 'pikno.rh.configure',
          context: {
            key_hash: await keyHash(apiKey),
            expected_version: expectedVersion,
          },
          title: t('Verify RH configuration change'),
        })
        if (!proof) return null

        return await authResult<RHStatus>(
          api.post(
            '/api/pikno/rh-config',
            { api_key: apiKey, expected_version: expectedVersion },
            {
              ...authRequestOptions,
              singleUseAuthorization: true,
              headers: { 'X-Security-Proof': proof.proof_token },
            }
          )
        )
      } catch {
        // Axios errors can retain the request body. Replace every failure with
        // a fixed error that carries neither the Key nor the Axios config.
        throw new AuthOperationError(t('RH operation did not complete'))
      }
    },
    retry: false,
    meta: { errorToast: false },
    onSettled: () => {
      resetForm()
      void queryClient.invalidateQueries({ queryKey: ['pikno-rh-config'] })
    },
  })
  const check = useMutation({
    mutationFn: () =>
      authResult<RHStatus>(
        api.post('/api/pikno/rh-config/check', undefined, authRequestOptions)
      ),
    retry: false,
    meta: { errorToast: false },
  })
  const { reset: resetSave } = save
  const { reset: resetCheck } = check

  useEffect(() => {
    if (!open) {
      resetForm()
      resetSave()
      resetCheck()
    }
  }, [open, resetCheck, resetForm, resetSave])

  const busy = save.isPending || check.isPending || verification.isActive
  let state = t('Not configured')
  if (status.isPending) state = t('Loading RH configuration...')
  else if (status.isError) state = t('RH configuration unavailable')
  else if (status.data?.configured) state = t('RH Key configured in cloud')

  return (
    <>
      <Dialog
        open={open && !verification.isActive}
        onOpenChange={(nextOpen) => {
          if (!busy) onOpenChange(nextOpen)
        }}
        title={t('RH dedicated configuration')}
        description={t('Digital human and depth video')}
        footer={
          <Button
            variant='outline'
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('Close')}
          </Button>
        }
      >
        <div className='flex flex-col gap-4'>
          <Alert>
            <AlertTitle>{state}</AlertTitle>
            <AlertDescription>
              {t(
                'The real RH Key is encrypted in the cloud execution service. It is not stored on ECS or in the hamster app. Do not replace the internal connection Key.'
              )}
            </AlertDescription>
          </Alert>
          <form onSubmit={form.handleSubmit(() => save.mutate())}>
            <FieldGroup>
              <Field
                data-invalid={Boolean(form.formState.errors.api_key)}
                data-disabled={busy}
              >
                <FieldLabel htmlFor='pikno-rh-key'>
                  {t('RH API Key')}
                </FieldLabel>
                <Input
                  id='pikno-rh-key'
                  type='password'
                  autoComplete='new-password'
                  spellCheck={false}
                  disabled={busy}
                  aria-invalid={Boolean(form.formState.errors.api_key)}
                  {...form.register('api_key')}
                />
                <FieldDescription>
                  {t(
                    'Enter a new Key only when replacing it. Saved Keys are never returned.'
                  )}
                </FieldDescription>
                {form.formState.errors.api_key && (
                  <FieldError>
                    {t('Enter the 32-character RH Key')}
                  </FieldError>
                )}
              </Field>
              <div className='flex flex-wrap gap-2'>
                <Button type='submit' disabled={busy || !status.data}>
                  {save.isPending
                    ? t('Saving...')
                    : t('Verify and save to cloud')}
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  disabled={busy || !status.data?.configured}
                  onClick={() => check.mutate()}
                >
                  {check.isPending
                    ? t('Checking connection...')
                    : t('Check saved RH authorization')}
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  disabled={busy || status.isFetching}
                  onClick={() => void status.refetch()}
                >
                  {t('Refresh status')}
                </Button>
              </div>
            </FieldGroup>
          </form>
          {(save.isError || check.isError) && (
            <Alert variant='destructive'>
              <AlertTitle>{t('RH operation did not complete')}</AlertTitle>
              <AlertDescription>
                {t(
                  'Refresh status before trying again. A failed configuration check does not submit a generation task.'
                )}
              </AlertDescription>
            </Alert>
          )}
          {save.isSuccess && save.data && (
            <p role='status'>
              {t(
                'Saved to cloud. Synchronize upstream lines, then enable and publish your selected tool line.'
              )}
            </p>
          )}
          {check.isSuccess && (
            <p role='status'>
              {t(
                'Read-only RH authorization passed. Workflow execution is not yet verified.'
              )}
            </p>
          )}
          <p className='text-muted-foreground text-sm'>
            {t(
              'Saving and checking do not open customer lines, change prices, reserve funds or run workflows. Digital human audio must not exceed 30 seconds.'
            )}
          </p>
        </div>
      </Dialog>
      <SecureVerificationDialog {...verification.dialogProps} />
    </>
  )
}
