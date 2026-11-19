/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { Plus, MoreHorizontal, Tags, ListChecks, SortAsc } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ADMIN_PERMISSION_ACTIONS,
  ADMIN_PERMISSION_RESOURCES,
  hasPermission,
} from '@/lib/admin-permissions'
import { useAuthStore } from '@/stores/auth-store'

import { useChannels } from './channels-provider'

export function ChannelsPrimaryButtons() {
  const { t } = useTranslation()
  const {
    setOpen,
    setCurrentRow,
    enableTagMode,
    setEnableTagMode,
    idSort,
    setIdSort,
    batchMode,
    setBatchMode,
  } = useChannels()
  const currentUser = useAuthStore((state) => state.auth.user)
  const canEditSensitive = hasPermission(
    currentUser,
    ADMIN_PERMISSION_RESOURCES.CHANNEL,
    ADMIN_PERMISSION_ACTIONS.SENSITIVE_WRITE
  )

  const handleTagModeToggle = (checked: boolean) => {
    localStorage.setItem('enable-tag-mode', String(checked))
    setEnableTagMode(checked)
  }
  const handleIdSortToggle = (checked: boolean) => {
    localStorage.setItem('channels-id-sort', String(checked))
    setIdSort(checked)
  }

  // Global channel actions deliberately have no entry in this scoped view:
  // they would also affect the RH connections managed outside this list.
  return (
    <div className='flex items-center gap-2'>
      <div className='hidden items-center gap-2 rounded-md border px-3 py-1.5 sm:flex'>
        <ListChecks className='text-muted-foreground h-4 w-4' />
        <Label htmlFor='channel-batch-mode' className='cursor-pointer text-sm'>
          {t('Batch Operations')}
        </Label>
        <Switch
          id='channel-batch-mode'
          checked={batchMode}
          onCheckedChange={setBatchMode}
        />
      </div>
      <div className='hidden items-center gap-2 rounded-md border px-3 py-1.5 sm:flex'>
        <Tags className='text-muted-foreground h-4 w-4' />
        <Label htmlFor='tag-mode' className='cursor-pointer text-sm'>
          {t('Tag Mode')}
        </Label>
        <Switch
          id='tag-mode'
          checked={enableTagMode}
          onCheckedChange={handleTagModeToggle}
        />
      </div>
      <div className='hidden items-center gap-2 rounded-md border px-3 py-1.5 sm:flex'>
        <SortAsc className='text-muted-foreground h-4 w-4' />
        <Label htmlFor='id-sort' className='cursor-pointer text-sm'>
          {t('Sort by ID')}
        </Label>
        <Switch
          id='id-sort'
          checked={idSort}
          onCheckedChange={handleIdSortToggle}
        />
      </div>
      <Tooltip>
        <TooltipTrigger render={<span className='inline-flex' />}>
          <Button
            onClick={() => {
              if (!canEditSensitive) return
              setCurrentRow(null)
              setOpen('create-channel')
            }}
            size='sm'
            disabled={!canEditSensitive}
          >
            <Plus className='h-4 w-4' />
            <span className='max-sm:hidden'>{t('Create Channel')}</span>
            <span className='sm:hidden'>{t('Create')}</span>
          </Button>
        </TooltipTrigger>
        {!canEditSensitive && (
          <TooltipContent>
            {t('No permission to perform this action')}
          </TooltipContent>
        )}
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant='outline'
              size='sm'
              className='sm:hidden'
              aria-label={t('Connection view options')}
            />
          }
        >
          <MoreHorizontal className='h-4 w-4' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-56'>
          <DropdownMenuGroup>
            <DropdownMenuCheckboxItem
              checked={batchMode}
              onCheckedChange={setBatchMode}
            >
              <ListChecks className='mr-2 h-4 w-4' />
              {t('Batch Operations')}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={enableTagMode}
              onCheckedChange={handleTagModeToggle}
            >
              <Tags className='mr-2 h-4 w-4' />
              {t('Tag Mode')}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={idSort}
              onCheckedChange={handleIdSortToggle}
            >
              <SortAsc className='mr-2 h-4 w-4' />
              {t('Sort by ID')}
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
