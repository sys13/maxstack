# Deployment

It assumes that we are doing ssr: true, as in you will need a server.

## Fly

1. Install the Fly CLI
1. Modify options in `deploy-fly.sh` and run `./deploy-fly.sh`
1. `fly deploy`
1. To seed the production db:

````fly ssh console
npm run db:seed```

### How to add a new environment variable

1. Add it to `.env.example` but do not add a value
1. Add it to `.env` with the production value
1. To deploy the new variable run `fly secrets set YOUR_ENV_VAR="THE VALUE"

### How to Deploy

Main way: `fly deploy`

If you want to use your own machine to build the image: `fly deploy --local-only`
````
