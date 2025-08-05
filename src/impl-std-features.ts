import { execSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { gen } from './bin/commands/gen.js'
import { StandardFeature } from './maxstack-parsing/msZod.js'
import { pages as blogPages } from './std-features/blog/pages.js'
import { relations as blogRelations } from './std-features/blog/relations.js'
import { schema as blogSchema } from './std-features/blog/schema.js'

const pages: Record<StandardFeature, typeof blogPages> = {
	blog: blogPages,
	'saas-marketing': blogPages,
}

const schema: Record<StandardFeature, string> = {
	blog: blogSchema,
	'saas-marketing': blogSchema,
}

const relations: Record<StandardFeature, string> = {
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

	updateRelationsFile({
		selectedFeatures,
		projectDir,
	})

	updateConfig({
		featureNames: selectedFeatures as StandardFeature[],
		projectDir,
	})

	await gen(projectDir)

	runPnpmInstall({ projectDir })

	dbGenAndMigrate({ projectDir })
}

function dbStuff({
	featureName,
	projectDir,
}: {
	featureName: StandardFeature
	projectDir: string
}) {
	const dbFolder = resolve(projectDir, 'database', featureName)
	mkdirSync(dbFolder, { recursive: true })

	const targetSchemaPath = resolve(dbFolder, 'schema.ts')
	writeFileSync(targetSchemaPath, schema[featureName])

	// append the schema to the main schema file
	const mainSchemaPath = resolve(projectDir, 'database', '_schema.ts')
	const mainSchemaText = readFileSync(mainSchemaPath, 'utf-8')
	const updatedMainSchemaText =
		mainSchemaText + '\n' + `export * from './${featureName}/schema'`
	writeFileSync(mainSchemaPath, updatedMainSchemaText)

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

function runPnpmInstall({ projectDir }: { projectDir: string }) {
	try {
		execSync('pnpm i', {
			cwd: projectDir,
			stdio: 'inherit',
		})
		console.log('Dependencies installed successfully.')
	} catch (error) {
		console.error('Error installing dependencies:', error)
	}
}

function updateRelationsFile({
	selectedFeatures,
	projectDir,
}: {
	selectedFeatures: string[]
	projectDir: string
}) {
	const mainRelationsPath = resolve(projectDir, 'database', 'relations.ts')
	const mainRelationsText = readFileSync(mainRelationsPath, 'utf-8')

	const allRelationsText = Object.entries(relations)
		.filter(([featureName]) => selectedFeatures.includes(featureName))
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		.map(([_, val]) => val)
		.join('\n')
	const newRelationsText = mainRelationsText.replace(
		'}))',
		allRelationsText + '}))',
	)
	writeFileSync(mainRelationsPath, newRelationsText)
}
