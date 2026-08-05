/**
 * The rendering half of the project surface dispatch.
 *
 * Paired with `project.surface.server.ts`, and split from it for the reason
 * every one of these surfaces is split: a plain module keeps whatever it
 * imports, so a component and a loader in the same non-route file ship
 * `~/sprout.server` to the browser.
 *
 * Three route modules render this — the project splat, the admin splat, and the
 * index route at `/` — which is the point: a spec page declared at
 * `/admin/posts` is the same page as one declared at `/posts` or at `/`, and the
 * prefix it happens to live under (or the router's reason for reaching it) is
 * not allowed to change what it is.
 */

import EditProjectRecord from './project.edit'
import NewProjectRecord from './project.new'
import ProjectListPage from './project.page'
import type { ProjectSurfaceData } from './project.surface.server'

export default function ProjectSurface({
	surface,
}: {
	surface: ProjectSurfaceData
}) {
	switch (surface.kind) {
		case 'list':
			return <ProjectListPage loaderData={surface.data} />
		case 'new':
			return <NewProjectRecord loaderData={surface.data} />
		case 'edit':
			return <EditProjectRecord loaderData={surface.data} />
	}
}
