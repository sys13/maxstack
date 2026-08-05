/**
 * USER-OWNED slot file (example). In a real project the generator writes this
 * once as a stub, then never touches it again — the user owns it whole.
 *
 * This is the exact case risk #1 calls out: "a trivial requirement (e.g. a
 * 'bulk-archive' button on a list) already needs a slot, not an op." Here it is
 * expressed as a slot fill, at the module boundary, with the generated page
 * (task.gen.tsx) free to regenerate around it.
 */

export function afterList() {
	return (
		<button type="button" data-testid="bulk-archive">
			Bulk archive
		</button>
	)
}
