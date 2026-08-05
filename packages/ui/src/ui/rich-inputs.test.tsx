import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FormFileInput } from './rich-inputs.tsx'

/** Simulate picking `file` via the (hidden) native file input. jsdom has no
 * real file-picker, but assigning `files` directly + firing `change` is the
 * standard workaround (same trick RTL's `userEvent.upload` uses internally). */
function pickFile(input: HTMLInputElement, file: File) {
	Object.defineProperty(input, 'files', { value: [file], configurable: true })
	fireEvent.change(input)
}

function jsonResponse(body: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init,
	})
}

describe('FormFileInput', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('uploads a picked file and submits the storage KEY, not the signed URL', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				key: 'abc123.png',
				url: '/files/abc123.png?exp=1&sig=deadbeef',
				name: 'photo.png',
			}),
		)
		const { container } = render(<FormFileInput name="avatar" image />)
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement
		const file = new File(['bytes'], 'photo.png', { type: 'image/png' })

		pickFile(fileInput, file)

		await waitFor(() =>
			expect(screen.getByText('photo.png')).toBeInTheDocument(),
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0] ?? []
		expect(url).toBe('/api/upload')
		expect(init?.method).toBe('POST')
		expect(init?.body).toBeInstanceOf(FormData)

		const hidden = container.querySelector(
			'input[type="hidden"][name="avatar"]',
		) as HTMLInputElement
		// The key, not the URL. A signed URL persisted into a column
		// is a value that silently stops working when it expires; a key is stable
		// and the read path re-signs it on every render.
		expect(hidden.value).toBe('abc123.png')
		expect(hidden.value).not.toContain('sig=')

		// no data: URL anywhere — the whole point of task 60.
		expect(hidden.value.startsWith('data:')).toBe(false)
	})

	it('tells the server which declared field the upload is for', async () => {
		// The server enforces *that field's* allowlist and cap, so it has to know
		// which field it is. These identify the declaration; they
		// never supply it.
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ key: 'k.png', url: '/files/k.png', name: 'p.png' }),
		)
		const { container } = render(
			<FormFileInput name="cover" resource="post" image />,
		)
		pickFile(
			container.querySelector('input[type="file"]') as HTMLInputElement,
			new File(['b'], 'p.png', { type: 'image/png' }),
		)
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

		const body = fetchMock.mock.calls[0]?.[1]?.body as FormData
		expect(body.get('resource')).toBe('post')
		expect(body.get('field')).toBe('cover')
	})

	it('previews an existing stored key through the server-supplied signer', async () => {
		const { container } = render(
			<FormFileInput
				name="cover"
				image
				defaultValue="stored-key.png"
				previewUrl={(key) => `/files/${key}?exp=9&sig=abc`}
			/>,
		)
		// The stored value round-trips unchanged...
		const hidden = container.querySelector(
			'input[type="hidden"][name="cover"]',
		) as HTMLInputElement
		expect(hidden.value).toBe('stored-key.png')
		// ...while the preview uses a freshly signed URL.
		expect(container.querySelector('img')?.getAttribute('src')).toBe(
			'/files/stored-key.png?exp=9&sig=abc',
		)
	})

	it('leaves a legacy URL value alone rather than rewriting it', async () => {
		const { container } = render(
			<FormFileInput name="cover" image defaultValue="/files/old.png?sig=x" />,
		)
		const hidden = container.querySelector(
			'input[type="hidden"][name="cover"]',
		) as HTMLInputElement
		expect(hidden.value).toBe('/files/old.png?sig=x')
	})

	it('posts to a custom uploadUrl when provided', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ key: 'k', url: '/files/k', name: 'a.txt' }),
		)
		const { container } = render(
			<FormFileInput name="doc" uploadUrl="/custom/upload" />,
		)
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement
		pickFile(fileInput, new File(['x'], 'a.txt', { type: 'text/plain' }))

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/custom/upload')
	})

	it('shows the server error and does not submit a value on a failed upload', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				{ error: 'File type "text/x-evil" is not allowed' },
				{
					status: 400,
				},
			),
		)
		const { container } = render(<FormFileInput name="doc" />)
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement
		pickFile(fileInput, new File(['x'], 'evil.sh', { type: 'text/x-evil' }))

		await waitFor(() =>
			expect(
				screen.getByText('File type "text/x-evil" is not allowed'),
			).toBeInTheDocument(),
		)
		const hidden = container.querySelector(
			'input[type="hidden"][name="doc"]',
		) as HTMLInputElement
		expect(hidden.value).toBe('')
	})

	it('rejects an over-limit file client-side without calling fetch', async () => {
		const { container } = render(<FormFileInput name="doc" maxSize={10} />)
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement
		pickFile(
			fileInput,
			new File(['x'.repeat(100)], 'big.txt', { type: 'text/plain' }),
		)

		await waitFor(() =>
			expect(screen.getByText(/exceeds the/i)).toBeInTheDocument(),
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('renders a pre-existing stored URL without re-uploading', () => {
		render(<FormFileInput name="avatar" defaultValue="/files/existing.png" />)
		expect(screen.getByText('existing.png')).toBeInTheDocument()
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
