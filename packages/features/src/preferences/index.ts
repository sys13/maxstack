/**
 * Preferences (task 55, promoted to a catalog bundle in issue #187) — typed
 * per-user and per-organization settings, resolved user → organization →
 * declared default, with the settings UI *derived* from the declarations
 * (`PreferencesService.describe`) rather than hand-built beside them.
 */

export {
	BUILT_IN_PREFERENCES,
	coercePreferenceValue,
	DEFAULT_PREFERENCE_GROUP,
	definitionErrors,
	type PreferenceDefinition,
	type PreferenceOption,
	type PreferenceScope,
	type PreferenceType,
	type PreferenceValue,
	valueMatchesType,
} from './definitions.ts'
export {
	migrateLegacyUserPreferences,
	organizationPreference,
	PREFERENCES_DDL,
	type PreferenceSqlRunner,
	userPreference,
} from './schema.ts'
export {
	canManageOrgPreferences,
	ORG_PREFERENCE_MANAGER_ROLES,
	type PreferenceActor,
	type PreferenceFieldView,
	type PreferenceGroupView,
	PreferencePermissionError,
	type PreferenceSource,
	PreferencesService,
	type PreferencesServiceOptions,
	type ResolvedPreference,
	ResolvedPreferences,
	UnknownPreferenceError,
} from './service.ts'
