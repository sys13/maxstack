/**
 * The generic admin's layout route — now only for the surfaces whose paths are
 * static (`/admin` itself and the read-only spec views).
 *
 * Everything below `/admin/:something` moved to `routes/admin.$.tsx` in issue
 * #252: those paths used to be four dynamic children here, and a dynamic child
 * outranks the project splat, so a spec page declared at `/admin/posts` was
 * routed as the generic CRUD for a resource named `posts`, missed the registry
 * (the entity is `post`) and 404'd. Resolving them needs the spec, which the
 * router cannot consult, so it happens inside a splat instead.
 */

import { Outlet } from 'react-router'
import { adminChromeData } from '~/admin.server'
import { AdminChrome } from '~/admin-chrome'
import type { Route } from './+types/admin'

export async function loader({ request }: Route.LoaderArgs) {
	return adminChromeData(request)
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
	return (
		<AdminChrome {...loaderData}>
			<Outlet />
		</AdminChrome>
	)
}
