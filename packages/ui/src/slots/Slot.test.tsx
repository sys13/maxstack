import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import TaskListPage from './example/task.gen.tsx'
import { Slot } from './Slot.tsx'

describe('Slot', () => {
	it('renders the user-supplied render component', () => {
		function Custom() {
			return <span data-testid="filled">filled</span>
		}
		render(<Slot name="afterList" render={Custom} />)
		expect(screen.getByTestId('filled')).toBeInTheDocument()
	})

	it('threads props into the render component', () => {
		function Greeting({ who }: { who: string }) {
			return <span data-testid="greet">hi {who}</span>
		}
		render(<Slot name="x" render={Greeting} props={{ who: 'maintainer' }} />)
		expect(screen.getByTestId('greet')).toHaveTextContent('hi maintainer')
	})

	it('falls back to children, then to fallback, then to nothing', () => {
		const { rerender, container } = render(
			<Slot name="x">
				<em data-testid="child">child</em>
			</Slot>,
		)
		expect(screen.getByTestId('child')).toBeInTheDocument()

		rerender(<Slot name="x" fallback={<em data-testid="fb">fb</em>} />)
		expect(screen.getByTestId('fb')).toBeInTheDocument()

		rerender(<Slot name="x" />)
		expect(container).toBeEmptyDOMElement()
	})
})

describe('generated page + user slot file compose end-to-end', () => {
	it('renders the generated page with the user-owned bulk-archive slot filled', () => {
		render(<TaskListPage />)
		// Framework-generated structure:
		expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument()
		// User-owned slot content, composed at the module boundary:
		expect(screen.getByTestId('bulk-archive')).toHaveTextContent('Bulk archive')
	})
})
