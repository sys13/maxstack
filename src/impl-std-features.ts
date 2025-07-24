import { execSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { gen } from './bin/commands/gen.js'
import { StandardFeature } from './maxstack-parsing/msZod.js'
import { pages as blogPages } from './std-features/blog/pages.js'
import { relations as blogRelations } from './std-features/blog/relations.js'

const __filename = fileURLToPath(import.meta.url)

const pages: Record<StandardFeature, typeof blogPages> = {
	blog: blogPages,
	'saas-marketing': blogPages,
}

const relations: Record<StandardFeature, typeof blogRelations> = {
	blog: blogRelations,
	'saas-marketing': blogRelations,
}

export async function implStdFeatures({
	selectedFeatures,
	projectDir,
}: {
	selectedFeatures: string[]
	projectDir: string
}) {
	console.log('Implementing standard features...')

	if (selectedFeatures.includes('blog')) {
		console.log('Implementing blog feature...')
		dbStuff({ featureName: 'blog', projectDir })
	}

	updateConfig({
		featureNames: selectedFeatures as StandardFeature[],
		projectDir,
	})

	await gen()

	const mainRelationsPath = resolve(projectDir, 'database', 'relations.ts')
	const mainRelationsText = readFileSync(mainRelationsPath, 'utf-8')

	const allRelationsText = Object.entries(relations)
		.filter(([featureName]) => selectedFeatures.includes(featureName))
		.map(([_, val]) => val)
		.join('\n')
	const mainRelationsWithoutClosing = mainRelationsText.replace(
		'}))',
		allRelationsText + '}))',
	)
	const updatedRelationsText =
		mainRelationsWithoutClosing + '\n' + allRelationsText + '\n}'
	writeFileSync(mainRelationsPath, updatedRelationsText)

	dbGenAndMigrate({ projectDir })
}

function dbStuff({
	featureName,
	projectDir,
}: {
	featureName: string
	projectDir: string
}) {
	// create folder /database/featureName
	const dbFolder = resolve(projectDir, 'database', featureName)
	mkdirSync(dbFolder, { recursive: true })

	const schemaPath = resolve(
		__filename,
		'std-features',
		featureName,
		'schema.ts',
	)
	const schemaText = readFileSync(schemaPath, 'utf-8')
	const targetSchemaPath = resolve(dbFolder, 'schema.ts')
	writeFileSync(targetSchemaPath, schemaText)

	// append the schema to the main schema file
	const mainSchemaPath = resolve(projectDir, 'database', '_schema.ts')
	const mainSchemaText = readFileSync(mainSchemaPath, 'utf-8')
	const updatedMainSchemaText =
		mainSchemaText + '\n' + `export * from './${featureName}/schema'`
	writeFileSync(mainSchemaPath, updatedMainSchemaText)

	// update the relations
	const relationsPath = resolve(
		projectDir,
		'std-features',
		featureName,
		'relations.ts',
	)
	const relationsText = readFileSync(relationsPath, 'utf-8')
	const targetRelationsPath = resolve(dbFolder, 'relations.ts')
	writeFileSync(targetRelationsPath, relationsText)

	// append the relations to the main relations file
	// replacing the last line with the new relations '}))'
}

function updateConfig({
	featureNames,
	projectDir,
}: {
	featureNames: StandardFeature[]
	projectDir: string
}) {
	const routes = featureNames.flatMap((featureName) => pages[featureName])

	const configPath = resolve(projectDir, 'maxstack.tsx')
	const configContent = readFileSync(configPath, 'utf-8')
	const updatedConfigContent = configContent.replace(
		'pages: []',
		`pages: ${JSON.stringify(routes, null, 2)}`,
	)

	writeFileSync(configPath, updatedConfigContent)
	console.log('Updated maxstack.tsx with routes:', routes)
}

function dbGenAndMigrate({ projectDir }: { projectDir: string }) {
	try {
		execSync('pnpm run db:generate & pnpm run db:migrate', {
			cwd: projectDir,
			stdio: 'inherit',
		})
		console.log('Database schema generated and migrated successfully.')
	} catch (error) {
		console.error('Error generating and migrating database schema:', error)
	}
}
