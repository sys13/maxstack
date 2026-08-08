/**
 * @maxstack/ui — shadcn-on-Base UI widgets + the Zod-schema-driven DynamicForm
 * (Sprout's form renderer).
 */

export {
	type AuthProvider,
	AuthProviderContext,
	type AuthProviderContextProps,
	type Identity,
	type UseAuthResult,
	useAuth,
	useAuthProvider,
} from './auth/auth-provider.tsx'
export {
	RequireAuth,
	type RequireAuthProps,
	RequireCapability,
	type RequireCapabilityProps,
} from './auth/guards.tsx'
export {
	ForgotPasswordForm,
	type ForgotPasswordFormProps,
	LoginForm,
	type LoginFormProps,
	LogoutButton,
	type LogoutButtonProps,
} from './auth/LoginForm.tsx'
export {
	EntitlementProvider,
	type EntitlementProviderProps,
	IfEntitled,
	type IfEntitledProps,
	IfFlag,
	type IfFlagProps,
	useEntitlement,
	useFlag,
} from './billing/gating.tsx'
export type {
	DraftStorage,
	DynamicFormProps,
	FieldCondition,
	FieldLayout,
	FieldUiOptions,
	FormLayout,
	FormSection,
	InputTypeOverride,
	SectionVariant,
} from './DynamicForm.tsx'
export { DynamicForm, referenceUiOptions } from './DynamicForm.tsx'
export {
	AggregateWidget,
	type AggregateWidgetProps,
	CountWidget,
	type CountWidgetProps,
	RecentActivity,
	type RecentActivityProps,
	StatCard,
} from './dashboard/widgets.tsx'
export {
	type UseMutationResult,
	useAggregate,
	useCount,
	useCustomQuery,
	useMutation,
	useSupportsAggregates,
} from './data/custom.ts'
export {
	DataProvider,
	type DataProviderProps,
	useDataProvider,
	useQueryClient,
} from './data/data-context.tsx'
export {
	createRestDataProvider,
	type DataProvider as DataProviderContract,
	DataProviderError,
	fieldErrorsFrom,
	type GetListParams,
	type GetListResult,
	type PaginationParam,
	type RecordId,
	type RestDataProviderOptions,
	type SortParam,
} from './data/data-provider.ts'
export {
	type DeleteMode,
	type DeleteOptions,
	type MutationOptions,
	type MutationState,
	type QueryResult,
	type UseInfiniteListOptions,
	type UseInfiniteListResult,
	type UseListResult,
	useCreate,
	useDelete,
	useInfiniteList,
	useList,
	useOne,
	useUpdate,
} from './data/hooks.ts'
export {
	type AggregateOp,
	type AggregateProvider,
	createMemoryDataProvider,
	type MemoryDataProviderOptions,
} from './data/memory-provider.ts'
export {
	type Notification,
	NotificationProvider,
	Notifications,
	type NotificationType,
	type NotifyFn,
	type NotifyOptions,
	useNotify,
} from './data/notifications.tsx'
export {
	QueryClient,
	type QueryKey,
	type QueryState,
	type QueryStatus,
	serializeKey,
} from './data/query-client.ts'
export {
	type BindingsLike,
	type BindingsProviderProps,
	createBindingsContext,
} from './di/bindings-context.tsx'
export {
	detectFieldKind,
	detectInputWidget,
	type FieldKind,
	type FieldMetaLike,
	type FieldReferenceLike,
	type IntrospectedColumn,
	multilineHint,
	nameHint,
	type SpecialtyWidget,
	specialtyHint,
} from './fields/field-semantics.ts'
export {
	BooleanField,
	ColorField,
	DateField,
	DurationField,
	EmailField,
	EmptyValue,
	EnumChip,
	Field,
	type FieldProps,
	FileField,
	formatDuration,
	GeoField,
	ImageField,
	JsonField,
	looksLikeImageSrc,
	MarkdownField,
	NumberField,
	PasswordField,
	parseLatLng,
	parseReferenceIds,
	RatingField,
	ReferenceArrayField,
	ReferenceField,
	RichTextField,
	ratingMax,
	relativeTime,
	TextField,
	UrlField,
} from './fields/fields.tsx'
export {
	FileProvider,
	type FileProviderProps,
	type FileResolution,
	isUrlValue,
	type ResolvedFile,
	useResolvedFile,
} from './fields/file-context.tsx'
export {
	ReferenceProvider,
	type ReferenceProviderProps,
	type ReferenceResolution,
	useReferenceValue,
} from './fields/reference-context.tsx'
export {
	type FormValues,
	getByPath,
	refineConditions,
	resolveConditions,
} from './form/conditions.ts'
export {
	DateInput,
	formatDateTyping,
	isCompleteDate,
} from './form/DateInput.tsx'
export { useDirtyGuard } from './form/use-dirty-guard.ts'
export {
	type FormDraft,
	type UseFormDraftOptions,
	useFormDraft,
} from './form/use-form-draft.ts'
export * from './format/timestamp.tsx'
export {
	type Catalog,
	createI18n,
	type I18n,
	type I18nConfig,
	type Messages,
	type TranslateParams,
} from './i18n/i18n.ts'
export {
	I18nProvider,
	type I18nProviderProps,
	LocaleSwitcher,
	type LocaleSwitcherProps,
	useFieldLabel,
	useI18n,
	useLocale,
	useTranslate,
} from './i18n/i18n-context.tsx'
export { renderMarkdown } from './markdown.ts'
export {
	type OrgContextValue,
	OrgProvider,
	type OrgProviderProps,
	type OrgSummary,
	OrgSwitcher,
	type OrgSwitcherProps,
	useOrg,
} from './org/org-context.tsx'
export {
	ClientOnly,
	PreferenceProvider,
	type PreferenceProviderProps,
	useHydrated,
	useHydratedStore,
	usePreferenceStore,
	useStore,
} from './prefs/prefs-context.tsx'
export {
	defaultBackend,
	memoryBackend,
	type PersistenceBackend,
	PreferenceStore,
	type PreferenceStoreOptions,
} from './prefs/store.ts'
export {
	applyTheme,
	type Density,
	type ResolvedTheme,
	type ThemeChoice,
	type UseDensityResult,
	type UseThemeResult,
	useDensity,
	useTheme,
} from './prefs/theme.tsx'
export {
	type Lock,
	LockStore,
	type LockStoreOptions,
} from './realtime/locks.ts'
export {
	type ChangeEvent,
	createPollingSubscription,
	type PollingOptions,
	type SubscriptionProvider,
	usePollingSubscription,
	useSubscription,
} from './realtime/subscriptions.ts'
export {
	LockBanner,
	type LockBannerProps,
	type UseRecordLockOptions,
	type UseRecordLockResult,
	useRecordLock,
} from './realtime/use-record-lock.tsx'
export {
	breadcrumbsFor,
	type Crumb,
	createResourceRegistry,
	type MenuEntry,
	type ResolvedResource,
	type ResourceDefinition,
	type ResourceRegistry,
	type ResourceRoute,
	type ResourceViews,
	resourceBasePath,
} from './registry/resource-registry.ts'
export {
	Breadcrumbs,
	type BreadcrumbsProps,
	type ErrorPageProps,
	Forbidden,
	Menu,
	type MenuProps,
	NotFound,
} from './registry/shell.tsx'
export {
	AggregateView,
	type AggregateViewBucket,
	type AggregateViewOption,
	type AggregateViewProps,
	aggregateKeyLabel,
	aggregateLabel,
} from './resource/AggregateView.tsx'
export {
	type BoardDrop,
	BoardView,
	type BoardViewProps,
} from './resource/BoardView.tsx'
export {
	type CalendarDisplay,
	CalendarView,
	type CalendarViewProps,
} from './resource/CalendarView.tsx'
export { CardGrid, type CardGridProps } from './resource/CardGrid.tsx'
export {
	ConfirmButton,
	type ConfirmButtonProps,
} from './resource/ConfirmButton.tsx'
export {
	addDays,
	type DayKey,
	dayKeyOf,
	daySpan,
	daysBetween,
	daysInMonth,
	entryDays,
	formatDayLabel,
	heatmapGrid,
	isDayKey,
	monthGrid,
	monthStart,
	weekday,
	weekGrid,
	weekStart,
} from './resource/calendar-days.ts'
export {
	applyColumnConfig,
	type ColumnConfig,
	configurableColumns,
	EMPTY_COLUMN_CONFIG,
	type UseColumnPrefsResult,
	useColumnPrefs,
} from './resource/column-prefs.ts'
export {
	type CsvColumn,
	type CsvExportOptions,
	cellToText,
	csvColumnsFor,
	downloadCsv,
	parseCsv,
	resourceToCsv,
	rowsToCsv,
} from './resource/csv.ts'
export {
	addTheFirst,
	EmptyState,
	type EmptyStateProps,
	resourceNoun,
} from './resource/EmptyState.tsx'
export {
	EditableCell,
	type EditableCellProps,
} from './resource/edit-in-place.tsx'
export { FeedList, type FeedListProps } from './resource/FeedList.tsx'
export {
	FilterForm,
	type FilterFormProps,
} from './resource/FilterForm.tsx'
export {
	filtersFromSearchParams,
	filtersToSearchParams,
	narrowFilters,
	sortFromSearchParams,
	sortToSearchParams,
} from './resource/filter-params.ts'
export {
	activeFilterCount,
	deriveFacets,
	EMPTY_FILTERS,
	type Facet,
	type FacetKind,
	type FacetOption,
	type FilterValues,
	isRelationFilterColumn,
	isSortableColumn,
	type RangeValue,
	searchableFields,
	sortableFields,
} from './resource/filterable.ts'
export {
	History,
	type HistoryEntry,
	type HistoryProps,
} from './resource/History.tsx'
export {
	type ColumnMapping,
	coerceValue,
	type ImportFieldError,
	type ImportResult,
	type ImportRowReport,
	importableColumns,
	suggestColumnMapping,
	validateImportRows,
} from './resource/import.ts'
export {
	ListControls,
	type ListControlsProps,
} from './resource/ListControls.tsx'
export type {
	OwnedRouteProps,
	OwnedViewProps,
} from './resource/owned-route.ts'
export {
	pickDate,
	pickDescription,
	pickPrimary,
} from './resource/pick-fields.ts'
export {
	ReferenceManyCount,
	type ReferenceManyCountProps,
} from './resource/ReferenceManyCount.tsx'
export {
	ReferenceManyField,
	type ReferenceManyFieldProps,
} from './resource/ReferenceManyField.tsx'
export {
	type ManyToManyRecord,
	ReferenceManyToManyField,
	type ReferenceManyToManyFieldProps,
} from './resource/ReferenceManyToManyField.tsx'
export {
	type RelatedGroup,
	RelatedRecords,
	type RelatedRecordsProps,
	relatedColumns,
} from './resource/RelatedRecords.tsx'
export {
	type BulkActionContext,
	type LinkLike,
	ResourceList,
	type ResourceListProps,
	type SortDir,
	type SortState,
} from './resource/ResourceList.tsx'
export {
	isRollupSeries,
	RollupSeries,
	type RollupSeriesBucket,
	type RollupSeriesProps,
} from './resource/RollupSeries.tsx'
export {
	compareRanked,
	isRankKey,
	type Ranked,
	rankBetween,
	rankForDrop,
} from './resource/rank.ts'
export type {
	CellRenderer,
	ColumnOverride,
	ColumnOverrides,
	IntrospectedResource,
	ResourceCapabilities,
	Row,
} from './resource/resource-types.ts'
export {
	SavedQueries,
	type SavedQueriesProps,
} from './resource/SavedQueries.tsx'
export { RecordDetail, Show, type ShowProps } from './resource/Show.tsx'
export { SimpleList, type SimpleListProps } from './resource/SimpleList.tsx'
export {
	type AppliedQuery,
	type SavedQuery,
	type UseSavedQueriesResult,
	useSavedQueries,
} from './resource/saved-queries.ts'
export {
	TimelineView,
	type TimelineViewProps,
} from './resource/TimelineView.tsx'
export {
	detectParentField,
	TreeList,
	type TreeListProps,
} from './resource/TreeList.tsx'
export {
	type BuildTreeOptions,
	buildTree,
	flattenTree,
	type TreeNode,
} from './resource/tree.ts'
export {
	buildRevisions,
	type ChangeKind,
	diffRecords,
	type FieldDiff,
	type Revision,
	type Snapshot,
} from './revisions/diff.ts'
export {
	RevisionHistory,
	type RevisionHistoryProps,
} from './revisions/RevisionHistory.tsx'
export {
	type UseRestoreOptions,
	useRestore,
} from './revisions/use-restore.ts'
export {
	type GlobalSearchOptions,
	type SearchableResource,
	type SearchGroup,
	type SearchHit,
	type UseGlobalSearchResult,
	useGlobalSearch,
} from './search/global-search.ts'
export {
	SearchPalette,
	type SearchPaletteProps,
	useSearchHotkey,
} from './search/SearchPalette.tsx'
export {
	type PreferenceField,
	type PreferenceFieldOption,
	type PreferenceFieldSource,
	type PreferenceFieldType,
	type PreferenceGroup,
	PreferencesForm,
	type PreferencesFormProps,
} from './settings/PreferencesForm.tsx'
export type {
	BlockSlotBaseProps,
	EmptySlotProps,
	FieldSlotProps,
	HeaderSlotProps,
	ListSlotProps,
	RowSlotProps,
} from './slots/block-slots.ts'
export { Slot, type SlotProps } from './slots/Slot.tsx'
export {
	FONT_STACKS,
	RADIUS_SCALES,
	THEME_PALETTES,
	THEME_TOKEN_NAMES,
	type ThemePalette,
	type ThemeTokenName,
	type ThemeTokens,
	TYPE_SCALES,
} from './theme/presets.ts'
export { hexLuminance, themeToCss } from './theme/theme-css.ts'
export {
	type AutocompleteOption,
	FormAutocomplete,
	FormCheckbox,
	FormMultiCheckboxGroup,
	FormRadioGroup,
	FormReferenceArrayInput,
	FormSelect,
} from './ui/form-fields.tsx'
export {
	Button,
	type ButtonSize,
	type ButtonVariant,
	buttonVariants,
	Input,
	Label,
	Textarea,
} from './ui/primitives.tsx'
export {
	FormColorInput,
	FormDurationInput,
	FormFileInput,
	FormGeoInput,
	FormJsonInput,
	FormMarkdownEditor,
	FormRating,
	FormRichTextEditor,
	FormSlider,
} from './ui/rich-inputs.tsx'
export {
	Alert,
	AlertTitle,
	type AlertVariant,
	Badge,
	type BadgeVariant,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Separator,
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from './ui/surfaces.tsx'
export * from './zod-to-form-fields.ts'
