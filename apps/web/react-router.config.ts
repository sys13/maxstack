import type { Config } from '@react-router/dev/config'

export default {
	// Server-rendered admin. Sprout resolves the store on the server, so SSR is
	// the natural default (SPA/pre-render are opt-in in later phases).
	ssr: true,
} satisfies Config
