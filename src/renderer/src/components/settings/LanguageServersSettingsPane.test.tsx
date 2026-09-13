// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageServersSettingsPane } from './LanguageServersSettingsPane'
import { resetLspDiagnosticsSubscriptionForTests } from '@/store/lsp-diagnostics'

afterEach(() => {
  cleanup()
  resetLspDiagnosticsSubscriptionForTests()
  vi.unstubAllGlobals()
})

it('shows startup failures and restarts the selected server with pending and error feedback', async () => {
  let reject!: (error: Error) => void
  const restart = vi.fn(
    () =>
      new Promise<void>((_resolve, reject_) => {
        reject = reject_
      })
  )
  vi.stubGlobal('api', {
    languageServers: {
      statuses: async () => [
        {
          rootPath: '/project',
          serverId: 'typescript',
          label: 'TypeScript',
          state: 'failed',
          restarts: 0,
          message: 'Initialization failed'
        }
      ],
      onDiagnosticsChanged: () => () => {},
      onStatusChanged: () => () => {},
      restart
    }
  })
  render(<LanguageServersSettingsPane />)
  expect(await screen.findByText('Initialization failed')).toBeTruthy()
  const button = screen.getByRole('button', { name: /Restart TypeScript/ }) as HTMLButtonElement
  fireEvent.click(button)
  expect(restart).toHaveBeenCalledWith({
    executionHostId: 'local',
    rootPath: '/project',
    serverId: 'typescript'
  })
  expect(button.disabled).toBe(true)
  reject(new Error('Executable is missing'))
  expect((await screen.findByRole('alert')).textContent).toContain('Executable is missing')
  await waitFor(() => expect(button.disabled).toBe(false))
})
