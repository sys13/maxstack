#!/usr/bin/env node

// Demo script showing runtime usage of maxstack in web applications
// This script demonstrates how web apps can import and use maxstack at runtime

import {
	generateConfigTemplate,
	generateTypesContent,
	toKebabCase,
} from '../lib/index.js'

console.log('🚀 Maxstack Runtime Demo')
console.log('=========================')

// Example 1: Using MAXConfig type in a web application
console.log('\n1. Using MAXConfig type in a web app:')
const webAppConfig = {
	name: 'My Web App',
	description: 'A sample web application using maxstack at runtime',
	standardFeatures: ['blog', 'user-authentication', 'saas-marketing'],
	pages: [
		{
			name: 'Home',
			description: 'Landing page',
			routePath: '/',
			components: ['Hero', 'Features', 'CTA'],
		},
		'About',
		'Contact',
	],
	models: [
		{
			name: 'User',
			fields: ['id', 'email', 'name'],
		},
		'Post',
		'Comment',
	],
}

console.log('✅ Config created:', JSON.stringify(webAppConfig, null, 2))

// Example 2: Using utility functions at runtime
console.log('\n2. Using utility functions:')
const projectName = 'My Amazing SaaS'
const kebabName = toKebabCase(projectName)
console.log(`✅ Project name: "${projectName}" → kebab-case: "${kebabName}"`)

// Example 3: Generating configuration templates dynamically
console.log('\n3. Generating configuration templates:')
const configTemplate = generateConfigTemplate(
	'default',
	'Dynamic App',
	'Generated at runtime',
	['blog', 'user-authentication'],
)
console.log('✅ Generated config template:')
console.log(configTemplate)

// Example 4: Generating types dynamically
console.log('\n4. Generating TypeScript types:')
const typesContent = generateTypesContent()
console.log(
	'✅ Generated types file length:',
	typesContent.length,
	'characters',
)
console.log(
	'✅ Contains MAXConfig interface:',
	typesContent.includes('export interface MAXConfig'),
)

console.log('\n🎉 Demo completed successfully!')
console.log('Web applications can now use maxstack as a runtime dependency!')
