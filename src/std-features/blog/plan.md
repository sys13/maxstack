# Blog README

## Features

- Post creation & editing
- Comments & replies
- Tagging & categories
- Search & filtering
- Auth (login/signup)
- Admin dashboard
- SEO metadata
- Pagination & slugs

## Pages

- `/` - Home feed
- `/post/:slug` - Single post
- `/create` - New post (auth)
- `/edit/:id` - Edit post (auth)
- `/login`, `/signup`
- `/admin` - Admin panel (auth)
- `/tags/:tag`, `/categories/:cat`

## Components

- `<PostCard />`
- `<PostEditor />`
- `<CommentThread />`
- `<TagList />`
- `<Navbar />`, `<Footer />`
- `<AuthForm />`
- `<SearchBar />`

## DB Schema (simplified)

- `User`: id, name, email, passwordHash, role
- `Post`: id, title, slug, content, authorId, createdAt, updatedAt
- `Comment`: id, postId, userId, content, parentId, createdAt
- `Tag`: id, name
- `PostTag`: postId, tagId
- `Category`: id, name
- `PostCategory`: postId, categoryId

## Unit Tests

- Post model (CRUD)
- Comment nesting logic
- Slug generation
- Auth validation
- Component rendering (e.g., PostCard)

## E2E Tests

- Create/edit/delete post
- Comment and reply flow
- Tag & category filtering
- Admin access control
- 404 and redirect cases
