#!/usr/bin/env node

import { AzureCliCredential, DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import {
  AzureOpenAI
} from 'openai';
import {
  SearchClient,
  SearchIndexClient
} from '@azure/search-documents';
import { BlobServiceClient } from '@azure/storage-blob';
import dotenv from 'dotenv';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mime from 'mime-types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

dotenv.config({
  path: path.resolve(repoRoot, '.env')
});

const args = new Set(process.argv.slice(2));
const requestedIndexCreation = args.has('--create-index');
const requestedDocumentProcessing = args.has('--process-documents');
const requestedWatch = args.has('--watch');
const requestedSampleUpload = args.has('--upload-samples');

function createCredential() {
  const forceAzureCli =
    process.env.KNOWLEDGE_USE_AZURE_CLI_CREDENTIAL === 'true' ||
    process.env.AZURE_AUTH_MODE === 'developer-login';

  if (forceAzureCli) {
    return new AzureCliCredential();
  }

  const managedIdentityClientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;

  return new DefaultAzureCredential(
    managedIdentityClientId ? { managedIdentityClientId } : undefined
  );
}

const credential = createCredential();
const cognitiveServicesScope = 'https://cognitiveservices.azure.com/.default';
const azureTokenProvider = getBearerTokenProvider(credential, cognitiveServicesScope);

const config = {
  location: process.env.AZURE_LOCATION || 'eastus2',
  searchService: process.env.AZURE_SEARCH_SERVICE || '',
  searchEndpoint: process.env.AZURE_SEARCH_ENDPOINT || '',
  searchIndexName: process.env.AZURE_SEARCH_INDEX || 'knowledge-index',
  searchDataSourceName: process.env.AZURE_SEARCH_DATASOURCE || 'knowledge-blob-datasource',
  storageAccount: process.env.AZURE_STORAGE_ACCOUNT || '',
  storageContainer: process.env.AZURE_STORAGE_CONTAINER || 'knowledge',
  documentIntelligenceEndpoint: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '',
  openAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
  openAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview',
  openAiEmbeddingDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small',
  vectorDimensions: Number(process.env.AZURE_SEARCH_EMBEDDING_DIMENSIONS || '1536'),
  vectorField: process.env.AZURE_SEARCH_VECTOR_FIELD || 'embedding',
  chunkSize: Number(process.env.KNOWLEDGE_CHUNK_SIZE || '1200'),
  chunkOverlap: Number(process.env.KNOWLEDGE_CHUNK_OVERLAP || '200'),
  pollIntervalSeconds: Number(process.env.KNOWLEDGE_INGESTION_INTERVAL_SECONDS || '60'),
  sampleDocsPath: path.resolve(__dirname, 'sample-docs'),
  stateFilePath: path.resolve(__dirname, '.ingestion-state.json')
};

function logStep(title, details) {
  console.log(`\n[knowledge-ingestion] ${title}`);
  if (details) {
    console.log(details);
  }
}

function assertRequiredConfig() {
  const missing = [];

  if (!config.searchService) missing.push('AZURE_SEARCH_SERVICE');
  if (!config.storageAccount) missing.push('AZURE_STORAGE_ACCOUNT');
  if (!config.openAiEndpoint) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!config.openAiEmbeddingDeployment) missing.push('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function getSearchEndpoint() {
  return config.searchEndpoint || `https://${config.searchService}.search.windows.net`;
}

function getBlobServiceClient() {
  return new BlobServiceClient(`https://${config.storageAccount}.blob.core.windows.net`, credential);
}

function getSearchIndexClient() {
  return new SearchIndexClient(getSearchEndpoint(), credential);
}

function getSearchClient() {
  return new SearchClient(getSearchEndpoint(), config.searchIndexName, credential);
}

function getOpenAiClient() {
  return new AzureOpenAI({
    endpoint: config.openAiEndpoint,
    apiVersion: config.openAiApiVersion,
    azureADTokenProvider: azureTokenProvider
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSampleDocs() {
  await fs.mkdir(config.sampleDocsPath, { recursive: true });

  const entries = await fs.readdir(config.sampleDocsPath, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  if (!files.length) {
    throw new Error(
      `No sample documents found in ${config.sampleDocsPath}. Add your knowledge files (.md, .txt, .pdf, ...) to that folder and rerun.`
    );
  }

  logStep('Sample documents ready', `${files.length} files in ${config.sampleDocsPath}`);

  return files;
}

function isStoragePermissionError(error) {
  return error?.code === 'AuthorizationPermissionMismatch' || error?.details?.errorCode === 'AuthorizationPermissionMismatch';
}

async function uploadSampleDocs() {
  const fileNames = await ensureSampleDocs();

  const blobServiceClient = getBlobServiceClient();
  const containerClient = blobServiceClient.getContainerClient(config.storageContainer);

  try {
    for (const fileName of fileNames) {
      const filePath = path.join(config.sampleDocsPath, fileName);
      const content = await fs.readFile(filePath);
      const blobClient = containerClient.getBlockBlobClient(fileName);
      const contentType = mime.lookup(fileName) || 'application/octet-stream';

      await blobClient.uploadData(content, {
        blobHTTPHeaders: {
          blobContentType: contentType
        },
        overwrite: true
      });
    }
  } catch (error) {
    if (isStoragePermissionError(error)) {
      throw new Error(
        'Storage Blob upload is not authorized. Ensure your signed-in user has Storage Blob Data Contributor on the storage account and wait a few minutes for RBAC propagation.'
      );
    }

    throw error;
  }

  logStep('Uploaded sample documents', `${fileNames.length} files uploaded to ${config.storageAccount}/${config.storageContainer}`);
}

async function createSearchIndex() {
  const searchIndexClient = getSearchIndexClient();

  const index = {
    name: config.searchIndexName,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, filterable: true, sortable: true },
      { name: 'title', type: 'Edm.String', searchable: true, filterable: true, sortable: true },
      { name: 'source', type: 'Edm.String', searchable: true, filterable: true, sortable: true },
      { name: 'content', type: 'Edm.String', searchable: true },
      { name: 'chunkIndex', type: 'Edm.Int32', filterable: true, sortable: true },
      { name: 'blobName', type: 'Edm.String', filterable: true, sortable: true },
      { name: 'etag', type: 'Edm.String', filterable: true },
      { name: 'lastModified', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
      {
        name: config.vectorField,
        type: 'Collection(Edm.Single)',
        searchable: true,
        vectorSearchDimensions: config.vectorDimensions,
        vectorSearchProfileName: 'default-vector-profile'
      }
    ],
    vectorSearch: {
      algorithms: [
        {
          name: 'default-hnsw',
          kind: 'hnsw'
        }
      ],
      profiles: [
        {
          name: 'default-vector-profile',
          algorithmConfigurationName: 'default-hnsw'
        }
      ]
    }
  };

  await searchIndexClient.createOrUpdateIndex(index);

  logStep('Search index ready', `service=${config.searchService}, index=${config.searchIndexName}`);
}

async function loadState() {
  try {
    const raw = await fs.readFile(config.stateFilePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.writeFile(config.stateFilePath, JSON.stringify(state, null, 2), 'utf8');
}

function sanitizeKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 128);
}

function chunkText(text) {
  const normalized = text.replace(/\r/g, '').trim();

  if (!normalized) {
    return [];
  }

  const chunks = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const end = Math.min(cursor + config.chunkSize, normalized.length);
    const slice = normalized.slice(cursor, end).trim();

    if (slice) {
      chunks.push(slice);
    }

    if (end === normalized.length) {
      break;
    }

    cursor = Math.max(end - config.chunkOverlap, cursor + 1);
  }

  return chunks;
}

async function extractTextFromBinary(buffer, contentType) {
  if (!config.documentIntelligenceEndpoint) {
    return '';
  }

  const token = await azureTokenProvider();
  const analyzeUrl = `${config.documentIntelligenceEndpoint.replace(/\/$/, '')}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2024-11-30`;
  const analyzeResponse = await fetch(analyzeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType || 'application/octet-stream'
    },
    body: buffer
  });

  if (!analyzeResponse.ok) {
    const errorBody = await analyzeResponse.text();
    throw new Error(`Document Intelligence analyze request failed: ${analyzeResponse.status} ${errorBody}`);
  }

  const operationLocation = analyzeResponse.headers.get('operation-location');

  if (!operationLocation) {
    throw new Error('Document Intelligence analyze response did not include operation-location.');
  }

  while (true) {
    await sleep(1500);

    const pollResponse = await fetch(operationLocation, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!pollResponse.ok) {
      throw new Error(`Document Intelligence polling failed: ${pollResponse.status}`);
    }

    const payload = await pollResponse.json();

    if (payload.status === 'succeeded') {
      return payload.analyzeResult?.content || '';
    }

    if (payload.status === 'failed') {
      throw new Error('Document Intelligence analysis failed.');
    }
  }
}

async function extractBlobText(blobName, buffer, contentType) {
  const extension = path.extname(blobName).toLowerCase();
  const textExtensions = new Set(['.txt', '.md', '.json', '.csv', '.html']);

  if (textExtensions.has(extension)) {
    return buffer.toString('utf8');
  }

  return extractTextFromBinary(buffer, contentType || 'application/octet-stream');
}

async function createEmbeddings(client, chunks) {
  const records = [];

  for (const chunk of chunks) {
    const response = await client.embeddings.create({
      model: config.openAiEmbeddingDeployment,
      input: chunk
    });

    records.push(response.data?.[0]?.embedding || []);
  }

  return records;
}

async function deleteDocumentsByBlob(searchClient, blobName) {
  const response = await searchClient.search('*', {
    filter: `blobName eq '${blobName.replace(/'/g, "''")}'`,
    top: 1000,
    select: ['id']
  });

  const documents = [];

  for await (const result of response.results) {
    documents.push({ id: result.document.id });
  }

  if (documents.length) {
    await searchClient.deleteDocuments(documents);
  }
}

async function indexBlob(searchClient, openAiClient, blobName, metadata, buffer) {
  const contentType = metadata.contentType || mime.lookup(blobName) || 'application/octet-stream';
  const extractedText = await extractBlobText(blobName, buffer, contentType);
  const chunks = chunkText(extractedText);

  if (!chunks.length) {
    logStep('Skipped empty blob', blobName);
    return [];
  }

  const embeddings = await createEmbeddings(openAiClient, chunks);

  await deleteDocumentsByBlob(searchClient, blobName);

  const documents = chunks.map((chunk, index) => ({
    id: sanitizeKey(`${blobName}-${index}`),
    title: path.basename(blobName),
    source: blobName,
    content: chunk,
    chunkIndex: index,
    blobName,
    etag: metadata.etag || '',
    lastModified: metadata.lastModified || new Date().toISOString(),
    [config.vectorField]: embeddings[index]
  }));

  await searchClient.uploadDocuments(documents);

  return documents.map((document) => document.id);
}

async function processDocuments() {
  assertRequiredConfig();

  const blobServiceClient = getBlobServiceClient();
  const containerClient = blobServiceClient.getContainerClient(config.storageContainer);
  const openAiClient = getOpenAiClient();
  const searchClient = getSearchClient();
  const state = await loadState();
  const nextState = {};
  const seenBlobNames = new Set();

  try {
    for await (const blob of containerClient.listBlobsFlat()) {
      seenBlobNames.add(blob.name);
      const stateKey = blob.name;
      const previous = state[stateKey];
      const etag = blob.properties.etag || '';
      const lastModified = blob.properties.lastModified?.toISOString() || '';

      if (previous?.etag === etag && previous?.lastModified === lastModified) {
        nextState[stateKey] = previous;
        continue;
      }

      const downloadResponse = await containerClient.getBlobClient(blob.name).downloadToBuffer();
      const documentIds = await indexBlob(
        searchClient,
        openAiClient,
        blob.name,
        {
          etag,
          lastModified,
          contentType: blob.properties.contentType
        },
        downloadResponse
      );

      nextState[stateKey] = {
        etag,
        lastModified,
        documentIds
      };

      logStep('Indexed blob', `${blob.name} -> ${documentIds.length} chunks`);
    }
  } catch (error) {
    if (isStoragePermissionError(error)) {
      throw new Error(
        'Storage Blob read is not authorized. Ensure your signed-in user has Storage Blob Data Contributor on the storage account and wait a few minutes for RBAC propagation.'
      );
    }

    throw error;
  }

  for (const [blobName] of Object.entries(state)) {
    if (!seenBlobNames.has(blobName)) {
      await deleteDocumentsByBlob(searchClient, blobName);
      logStep('Deleted missing blob from index', blobName);
    }
  }

  await saveState(nextState);
  logStep('Document sync completed', `tracked=${Object.keys(nextState).length}`);
}

async function watchDocuments() {
  logStep('Watcher started', `Polling every ${config.pollIntervalSeconds}s`);

  while (true) {
    try {
      await processDocuments();
    } catch (error) {
      logStep('Watcher iteration failed', error.message || String(error));
    }

    await sleep(config.pollIntervalSeconds * 1000);
  }
}

function printUsage() {
  logStep(
    'Usage',
    'Use --create-index, --upload-samples, --process-documents, or --watch. Commands can be combined in one run.'
  );
}

(async () => {
  if (!requestedIndexCreation && !requestedDocumentProcessing && !requestedWatch && !requestedSampleUpload) {
    printUsage();
    process.exit(0);
  }

  if (requestedIndexCreation) {
    await createSearchIndex();
  }

  if (requestedSampleUpload) {
    await uploadSampleDocs();
  }

  if (requestedDocumentProcessing) {
    await processDocuments();
  }

  if (requestedWatch) {
    await watchDocuments();
  }

  logStep('Completed', 'Knowledge ingestion commands executed successfully.');
})().catch((error) => {
  console.error('\n[knowledge-ingestion] Fatal error');
  console.error(error);
  process.exit(1);
});
