// Produces a reviewable, game-only change to an existing distribution.
// This script never calls AWS or uploads files.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareGameRoutes(current, outputs, prefix = '/finalfight') {
  if (!/^\/[A-Za-z0-9_-]+$/.test(prefix)) throw Error('Invalid game prefix');
  const config = structuredClone(current);
  const originId = 'finalfight-save-api';
  const defaultBehavior = current.DefaultCacheBehavior;
  if (!current.Origins.Items.some(o => o.Id === defaultBehavior.TargetOriginId)) throw Error('Existing default origin is missing');
  const url = new URL(outputs.ApiFunctionUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.on.aws') || url.pathname !== '/') throw Error('Invalid Lambda function URL');
  for (const key of ['ApiOriginAccessControlId', 'ApiOriginRequestPolicyId', 'ApiSiteHeaderFunctionArn']) if (!outputs[key]) throw Error('Missing stack output: ' + key);
  const association = { Quantity: 1, Items: [{ EventType: 'viewer-request', FunctionARN: outputs.ApiSiteHeaderFunctionArn }] };
  const paths = new Set([prefix + '/api/*', prefix, prefix + '/*']);
  const oldBehaviors = current.CacheBehaviors.Items || [];
  for (const behavior of oldBehaviors) {
    if (paths.has(behavior.PathPattern) && ![originId, defaultBehavior.TargetOriginId].includes(behavior.TargetOriginId)) throw Error('Game route points at an unexpected origin; review before replacing');
  }
  const origin = {
    Id: originId, DomainName: url.hostname, OriginPath: '', CustomHeaders: { Quantity: 0 },
    CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: 'https-only', OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] }, OriginReadTimeout: 30, OriginKeepaliveTimeout: 5 },
    ConnectionAttempts: 3, ConnectionTimeout: 10, OriginShield: { Enabled: false }, OriginAccessControlId: outputs.ApiOriginAccessControlId
  };
  const existingOrigin = current.Origins.Items.find(o => o.Id === originId);
  if (existingOrigin && !existingOrigin.DomainName.endsWith('.lambda-url.eu-west-1.on.aws')) throw Error('Origin name is already used by another service');
  config.Origins.Items = [...current.Origins.Items.filter(o => o.Id !== originId), origin];
  config.Origins.Quantity = config.Origins.Items.length;
  const staticBehavior = pattern => ({ ...structuredClone(defaultBehavior), PathPattern: pattern, FunctionAssociations: structuredClone(association) });
  const api = {
    ...structuredClone(defaultBehavior), PathPattern: prefix + '/api/*', TargetOriginId: originId,
    ViewerProtocolPolicy: 'https-only', AllowedMethods: { Quantity: 7, Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } },
    CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', OriginRequestPolicyId: outputs.ApiOriginRequestPolicyId,
    FunctionAssociations: structuredClone(association), LambdaFunctionAssociations: { Quantity: 0 }, Compress: true
  };
  config.CacheBehaviors = { Quantity: 0, Items: [api, staticBehavior(prefix), staticBehavior(prefix + '/*'), ...oldBehaviors.filter(b => !paths.has(b.PathPattern))] };
  config.CacheBehaviors.Quantity = config.CacheBehaviors.Items.length;
  // Fail closed if a future edit changes any unrelated distribution setting.
  for (const key of Object.keys(current)) {
    if (!['Origins', 'CacheBehaviors'].includes(key) && JSON.stringify(config[key]) !== JSON.stringify(current[key])) throw Error('Unrelated setting changed: ' + key);
  }
  for (const old of current.Origins.Items.filter(o => o.Id !== originId)) if (JSON.stringify(config.Origins.Items.find(o => o.Id === old.Id)) !== JSON.stringify(old)) throw Error('Unrelated origin changed');
  for (const old of oldBehaviors.filter(b => !paths.has(b.PathPattern))) if (JSON.stringify(config.CacheBehaviors.Items.find(b => b.PathPattern === old.PathPattern)) !== JSON.stringify(old)) throw Error('Unrelated behavior changed');
  return config;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [currentFile, outputsFile, destination] = process.argv.slice(2);
  if (!destination) throw Error('Usage: node scripts/prepare-cloudfront.mjs current.json stack-outputs.json proposed.json');
  const current = JSON.parse(await readFile(currentFile, 'utf8'));
  const data = JSON.parse(await readFile(outputsFile, 'utf8'));
  const outputs = Array.isArray(data) ? Object.fromEntries(data.map(o => [o.OutputKey, o.OutputValue])) : data;
  const config = prepareGameRoutes(current.DistributionConfig || current, outputs);
  await writeFile(destination, JSON.stringify(config, null, 2) + '\n');
  console.log('Prepared game routes only: /finalfight/api/*, /finalfight, /finalfight/*. Existing default behavior preserved.');
}
