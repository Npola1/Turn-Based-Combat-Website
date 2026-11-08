# Existing website deployment

Use `https://<your-domain>/finalfight/` for the game. Replace the placeholders
below with your own deployment values; keep actual account configuration private.

```text
Browser → existing CloudFront → existing S3 bucket /finalfight/ (game assets)
                             → /finalfight/api/* → Lambda → Aurora DSQL
```

The frontend resolves API requests relative to `save-system.js`. The game-owned
CloudFront Function strips `/finalfight` from API paths before Lambda receives
them. The player cookie is restricted to `/finalfight/`.

## Resources

| Resource | Name or identifier |
| --- | --- |
| Website bucket (existing, us-east-1) | `<website-bucket>`, game prefix `finalfight/` |
| CloudFront distribution (existing) | `<distribution-id>` |
| Backend stack (eu-west-1) | `<backend-stack-name>` |
| Lambda | `<lambda-function-name>` |
| Aurora DSQL cluster | `<dsql-cluster-id>` |
| Artifact stack (eu-west-1) | `<artifact-stack-name>` |
| Private deployment/backup bucket | `<private-artifact-bucket>` |

The artifact bucket can be provisioned with `aws/artifacts.template.json`, passing
`ArtifactBucketName=<private-artifact-bucket>`. For an existing stack, supply its
current bucket name to preserve that bucket.

`aws/existing-site.template.json` owns the backend and game-specific CloudFront
Function/access control. It does not own the shared website bucket, distribution,
DNS or existing redirect function. The distribution keeps its existing pricing plan.
The API uses AWS's managed **AllViewerExceptHostHeader** origin request policy
and **CachingDisabled** cache policy. CloudFront signs requests to the
IAM-protected Lambda URL; direct public requests to that URL return 403.

The existing shared WAF configuration is unchanged. Its managed body-size rule
allows at most 8 KiB per request, so the game splits larger writes into 5 KiB binary
chunks with base64 JSON envelopes. The server commits the assembled save/history
atomically and retains the overall 8 MiB write limit. Retry receipts prevent
duplicate commits.

Only three cache behaviors were added: `/finalfight/api/*`, `/finalfight`, and
`/finalfight/*`. The default behavior and existing S3 origin were preserved.

## Publish a later release

Run commands from the project directory with Node.js 22.13+ and AWS CLI credentials
for your account. SAM CLI is optional; CloudFormation processes the SAM template.

```sh
export SITE_DOMAIN='<your-apex-domain>'
export SITE_BUCKET='<website-bucket>'
export DISTRIBUTION_ID='<distribution-id>'
export ARTIFACT_BUCKET='<private-artifact-bucket>'
export BACKEND_STACK='<backend-stack-name>'
# eu-west-1 and us-east-1 below are example regions; use your resource regions.

npm ci
npm test
npm run build:aws

aws cloudformation package \
  --template-file aws/existing-site.template.json \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --s3-prefix lambda --use-json \
  --output-template-file /tmp/finalfight-backend.json --region eu-west-1

aws cloudformation deploy \
  --template-file /tmp/finalfight-backend.json \
  --stack-name "$BACKEND_STACK" --region eu-west-1 \
  --parameter-overrides ExistingDistributionId="$DISTRIBUTION_ID" SitePrefix=/finalfight SiteDomain="$SITE_DOMAIN" \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND
```

If schema objects change, run `npm run db:init` with `AWS_REGION=eu-west-1`,
`RPG_DSQL_HOST` and `RPG_LAMBDA_ROLE_ARN` from the backend stack's outputs.
Use admin/deployment credentials for this command; Lambda retains only application
access. This initializes missing objects; incompatible schema migrations require
a separate plan.

Upload **only `dist/site`**, with no deletion flag. Publish the entry page last:

```sh
aws s3 sync dist/site/ "s3://$SITE_BUCKET/finalfight/" \
  --exclude index.html --region us-east-1
aws s3 cp dist/site/save-system.js "s3://$SITE_BUCKET/finalfight/save-system.js" \
  --content-type 'application/javascript; charset=utf-8' --cache-control no-cache
aws s3 cp dist/site/save-system.css "s3://$SITE_BUCKET/finalfight/save-system.css" \
  --content-type 'text/css; charset=utf-8' --cache-control no-cache
aws s3 cp dist/site/index.html "s3://$SITE_BUCKET/finalfight/index.html" \
  --content-type 'text/html; charset=utf-8' --cache-control no-cache
aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" --paths '/finalfight*'
```

Never sync the repository root to the website. `data`, `node_modules`, backend
source, deployment artifacts and reports are excluded from the static build.

Normal releases do not require editing the shared distribution. If a backend URL,
access control or game function ARN changes, fetch a **fresh** distribution config
and backend stack outputs, then use `scripts/prepare-cloudfront.mjs` to generate a
reviewable proposed config. Apply it with the fresh ETag only after checking its
diff. The helper preserves shared settings and unrelated routes. Never add a
site-wide `/api/*` route or change the default behavior for this game.

## Verify and recover

Check the game URL and `/finalfight/api/saves`. The browser smoke test uses a fresh
profile and writes only a new test player's data:

```sh
RPG_TEST_URL="https://$SITE_DOMAIN/finalfight/" \
  node scripts/test-game.mjs --worker browser
```

It verifies opening autosave, manual save/overwrite, refresh/load, inventory,
turn state, combat history and a second battle. Normal `npm test` remains local.

Verified on 8 November 2026: the live browser smoke test passed, and the local
suite reported 1,152 passes, zero failures and eight skipped checks. All 81 built
game files matched their uploaded bytes. The final audit confirmed that all nine
non-game S3 objects, the existing CloudFront origin/default settings, the shared
WAF configuration and the original redirect function were unchanged. Audit
results are retained in the private artifact bucket under
`deployments/2026-11-08/`.

The first deployment backed up the original `finalfight/` objects and shared
CloudFront configuration to the private artifact bucket under
`backups/before-first-deployment/`. For rollback, restore only game objects and
remove/revert only the three game behaviors and the game API origin. Re-read the
distribution first so unrelated later changes are preserved. DSQL deletion
protection and stack retention are enabled; do not delete the database to roll
back an application release. These static backups do not back up ongoing SQL data.
