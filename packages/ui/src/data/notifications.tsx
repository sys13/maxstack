/**
 * A tiny toast system whose one non-negotiable feature is the **undo** button —
 * it's what makes an undoable delete (Plan v5 task 33) feel alive. The mutation
 * hooks call `useNotify()`; a `<Notifications>` renderer near the app root shows
 * the toasts. Both are optional: with no `<NotificationProvider>` mounted,
 * `useNotify` is a no-op, so a mutation still works (it just commits silently).
 */

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from 'react'
import { Button } from '../ui/primitives.tsx'

export type NotificationType = 'info' | 'success' | 'error'

export interface NotifyOptions {
	type?: NotificationType
	/** Show an "Undo" button; clicking it runs `onUndo` and dismisses. */
	undoable?: boolean
	onUndo?: () => void
	/** Auto-dismiss after this many ms (default 5000; 0 disables). For an
	 * undoable toast this should match the hook's commit delay. */
	duration?: number
}

export interface Notification extends NotifyOptions {
	id: number
	message: string
	type: NotificationType
}

export type NotifyFn = (message: string, options?: NotifyOptions) => void

interface NotificationContextValue {
	notify: NotifyFn
	notifications: Notification[]
	dismiss: (id: number) => void
}

const noop: NotifyFn = () => {}

const NotificationContext = createContext<NotificationContextValue>({
	notify: noop,
	notifications: [],
	dismiss: () => {},
})

export function NotificationProvider({ children }: { children: ReactNode }) {
	const [notifications, setNotifications] = useState<Notification[]>([])
	const nextId = useRef(0)
	const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

	const dismiss = useCallback((id: number) => {
		const timer = timers.current.get(id)
		if (timer) {
			clearTimeout(timer)
			timers.current.delete(id)
		}
		setNotifications((all) => all.filter((n) => n.id !== id))
	}, [])

	const notify = useCallback<NotifyFn>(
		(message, options = {}) => {
			const id = nextId.current++
			const notification: Notification = {
				id,
				message,
				type: options.type ?? 'info',
				...options,
			}
			setNotifications((all) => [...all, notification])
			const duration = options.duration ?? 5000
			if (duration > 0) {
				timers.current.set(
					id,
					setTimeout(() => dismiss(id), duration),
				)
			}
		},
		[dismiss],
	)

	const value = useMemo(
		() => ({ notify, notifications, dismiss }),
		[notify, notifications, dismiss],
	)
	return (
		<NotificationContext.Provider value={value}>
			{children}
		</NotificationContext.Provider>
	)
}

/** The imperative notifier the mutation hooks call. A no-op when no provider is
 * mounted, so hooks never require the toast UI to function. */
export function useNotify(): NotifyFn {
	return useContext(NotificationContext).notify
}

/**
 * One line per type instead of a light/dark pair each: a token already carries
 * both modes, so `dark:` overrides are only needed by a literal palette colour
 * that cannot move on its own. These match the `Alert` variants of the same
 * names — a toast and a banner saying the same thing should not be two colours.
 */
const TYPE_CLASS: Record<NotificationType, string> = {
	info: 'border-border bg-background text-foreground',
	success: 'border-success/30 bg-success/10 text-success',
	error: 'border-destructive/30 bg-destructive/10 text-destructive',
}

/** Renders the active toasts, bottom-left. Mount once near the app root. */
export function Notifications({ className }: { className?: string }) {
	const { notifications, dismiss } = useContext(NotificationContext)
	if (notifications.length === 0) return null
	return (
		<output
			className={
				className ?? 'fixed bottom-4 left-4 z-50 flex w-80 flex-col gap-2'
			}
			aria-live="polite"
		>
			{notifications.map((n) => (
				<div
					key={n.id}
					className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm shadow-lg ${TYPE_CLASS[n.type]}`}
				>
					<span className="min-w-0 flex-1">{n.message}</span>
					{n.undoable ? (
						<Button
							type="button"
							className="h-7 bg-transparent px-2 text-xs text-current shadow-none hover:bg-black/5 dark:hover:bg-white/10"
							onClick={() => {
								n.onUndo?.()
								dismiss(n.id)
							}}
						>
							Undo
						</Button>
					) : null}
				</div>
			))}
		</output>
	)
}
