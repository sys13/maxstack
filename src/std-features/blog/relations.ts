export const relations = `
	post: {
		author: r.one.user({
			from: r.post.authorId,
			to: r.user.id,
		}),
		comments: r.many.blogComment({
			from: r.post.id,
			to: r.blogComment.postId,
		}),
		categories: r.many.postCategory({
			from: r.post.id,
			to: r.postCategory.postId,
		}),
		tags: r.many.postTag({
			from: r.post.id,
			to: r.postTag.postId,
		}),
	},
	postCategory: {
		category: r.one.category({
			from: r.postCategory.categoryId,
			to: r.category.id,
		}),
		post: r.one.post({
			from: r.postCategory.postId,
			to: r.post.id,
		}),
	},
	postTag: {
		post: r.one.post({
			from: r.postTag.postId,
			to: r.post.id,
		}),
		tag: r.one.tag({
			from: r.postTag.tagId,
			to: r.tag.id,
		}),
	},
	blogComment: {
		user: r.one.user({
			from: r.blogComment.userId,
			to: r.user.id,
		}),
		post: r.one.post({
			from: r.blogComment.postId,
			to: r.post.id,
		}),
		parent: r.one.blogComment({
			from: r.blogComment.parentId,
			to: r.blogComment.id,
		}),
	},
`
