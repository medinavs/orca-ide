// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { VscodeExtensionsSettingsSection } from './VscodeExtensionsSettingsSection'

vi.mock('./SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>
}))
vi.mock('@/store/vscode-extensions', () => ({
  startVscodeExtensionsSubscription: () => {},
  useVscodeExtensionsStore: (select: (state: unknown) => unknown) =>
    select({
      extensions: [
        {
          extensionId: 'test.theme',
          displayName: 'Test theme',
          version: '1',
          enabled: true,
          themes: [{ id: 'theme-dark', label: 'Test dark', type: 'dark' }],
          summary: '',
          unsupported: [],
          problems: []
        }
      ],
      status: 'ready',
      error: null,
      registeredThemeIds: ['theme-dark'],
      refresh: vi.fn()
    })
}))
afterEach(cleanup)

it('uses the application select and preserves theme selection and the default reset', async () => {
  const updateSettings = vi.fn().mockResolvedValue(undefined)
  const { rerender } = render(
    <VscodeExtensionsSettingsSection
      settings={getDefaultSettings('/home/test')}
      updateSettings={updateSettings}
    />
  )
  const select = screen.getByRole('combobox', { name: 'Editor color theme' })
  expect(select.tagName).toBe('BUTTON')
  fireEvent.keyDown(select, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: 'Test dark' }))
  expect(updateSettings).toHaveBeenCalledWith({ vscodeColorThemeId: 'theme-dark' })
  rerender(
    <VscodeExtensionsSettingsSection
      settings={{ ...getDefaultSettings('/home/test'), vscodeColorThemeId: 'theme-dark' }}
      updateSettings={updateSettings}
    />
  )
  fireEvent.keyDown(select, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: 'Orca default' }))
  expect(updateSettings).toHaveBeenLastCalledWith({ vscodeColorThemeId: '' })
})
