import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { SearchClient } from '@azure/search-documents';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AzureOpenAI } from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, '..', '..', '.env')
});

const app = express();
const port = process.env.PORT || 8080;
const managedIdentityClientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = new DefaultAzureCredential(
  managedIdentityClientId ? { managedIdentityClientId } : undefined
);
const cognitiveServicesScope = 'https://cognitiveservices.azure.com/.default';
const azureTokenProvider = getBearerTokenProvider(credential, cognitiveServicesScope);
const openAiApiVersion = process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview';
const searchIndexName = process.env.AZURE_SEARCH_INDEX || 'knowledge-index';

app.use(cors());
app.use(express.json());

function hasFoundryConfig() {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_CHAT_DEPLOYMENT &&
    process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT
  );
}

function hasSearchConfig() {
  return Boolean(process.env.AZURE_SEARCH_SERVICE && searchIndexName);
}

function buildOpenAiClient() {
  if (!hasFoundryConfig()) {
    return null;
  }

  return new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiVersion: openAiApiVersion,
    azureADTokenProvider: azureTokenProvider
  });
}

function buildSearchClient() {
  if (!hasSearchConfig()) {
    return null;
  }

  const endpoint = process.env.AZURE_SEARCH_ENDPOINT || `https://${process.env.AZURE_SEARCH_SERVICE}.search.windows.net`;

  return new SearchClient(endpoint, searchIndexName, credential);
}

function formatErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error) {
    return error;
  }

  return JSON.stringify(error) || 'Unknown error';
}

function normalizeDocument(document, index) {
  return {
    id: document.id || document.chunk_id || document.key || `doc-${index + 1}`,
    title: document.title || document.metadata_storage_name || document.source || `Document ${index + 1}`,
    source: document.source || document.metadata_storage_name || document.title || `Document ${index + 1}`,
    content: document.content || document.chunk || document.text || document.page_content || JSON.stringify(document)
  };
}

async function createEmbedding(client, input) {
  const result = await client.embeddings.create({
    model: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    input
  });

  return result.data?.[0]?.embedding || [];
}

async function searchDocuments(question) {
  const searchClient = buildSearchClient();

  if (!searchClient) {
    return [];
  }

  const documents = [];

  try {
    const openAiClient = buildOpenAiClient();
    const vector = openAiClient ? await createEmbedding(openAiClient, question) : [];
    const vectorField = process.env.AZURE_SEARCH_VECTOR_FIELD || 'embedding';
    try {
      const response = await searchClient.search(question, {
        top: 5,
        vectorSearchOptions: vector.length
          ? {
              queries: [
                {
                  kind: 'vector',
                  vector,
                  fields: vectorField,
                  kNearestNeighborsCount: 5
                }
              ]
            }
          : undefined
      });

      for await (const result of response.results) {
        documents.push(normalizeDocument(result.document, documents.length));
      }
    } catch (vectorError) {
      console.warn('[search] Vector/hybrid search failed, falling back to text search:', formatErrorMessage(vectorError));
      const fallbackResponse = await searchClient.search(question, { top: 5 });

      for await (const result of fallbackResponse.results) {
        documents.push(normalizeDocument(result.document, documents.length));
      }
    }
  } catch (error) {
    console.error('[search] Search request failed:', formatErrorMessage(error));
    return [];
  }

  if (!documents.length) {
    console.warn('[search] No documents returned. Index may be empty or RBAC/permission may be missing.');
  }

  return documents;
}

async function answerWithFoundry(question, language, documents) {
  const client = buildOpenAiClient();

  if (!client) {
    return {
      answer: documents.length
        ? documents.map((document, index) => `[${index + 1}] ${document.content}`).join('\n\n')
        : 'Foundry/OpenAI configuration is missing.',
      citations: documents.map(({ source, content }) => ({
        source,
        snippet: content.slice(0, 280)
      })),
      metadata: {
        retrievalMode: documents.length ? 'search-only' : 'unconfigured-foundry'
      }
    };
  }

  const contextBlock = documents.length
    ? documents
        .map((document, index) => `[${index + 1}] Source: ${document.source}\n${document.content}`)
        .join('\n\n')
    : 'No indexed documents were retrieved.';

  const completion = await client.chat.completions.create({
    model: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT,
    temperature: 0.2,
    max_tokens: 700,
    messages: [
      {
        role: 'system',
        content: `You are a retrieval assistant. Reply in ${language}. Use only the provided context for factual claims. If context is insufficient, say so clearly.`
      },
      {
        role: 'user',
        content: `Question: ${question}\n\nContext:\n${contextBlock}`
      }
    ]
  });

  return {
    answer: completion.choices?.[0]?.message?.content?.trim() || 'Yanit alinamadi.',
    citations: documents.map(({ source, content }) => ({
      source,
      snippet: content.slice(0, 280)
    })),
    metadata: {
      retrievalMode: documents.length ? 'hybrid' : 'chat-only',
      service: process.env.AZURE_SEARCH_SERVICE || 'unset',
      model: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'unset'
    }
  };
}

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'rag-service',
    configured: {
      foundry: hasFoundryConfig(),
      search: hasSearchConfig()
    }
  });
});

app.get('/mcp/tools', (_req, res) => {
  res.json({
    tools: [
      {
        name: 'answer_question',
        description: 'Hybrid+vector retrieval over Azure AI Search with citation response.'
      }
    ]
  });
});

app.post('/mcp/tools/answer_question', (req, res) => {
  const { question, language = 'tr-TR' } = req.body || {};

  (async () => {
    if (!question) {
      res.status(400).json({
        error: 'missing_question',
        message: 'question is required'
      });

      return;
    }

    try {
      const documents = await searchDocuments(question);
      const answer = await answerWithFoundry(question, language, documents);

      res.json({
        question,
        language,
        answer: answer.answer,
        citations: answer.citations,
        metadata: answer.metadata
      });
    } catch (error) {
      res.status(500).json({
        error: 'answer_question_failed',
        message: formatErrorMessage(error)
      });
    }
  })();
});

app.listen(port, () => {
  console.log(`rag-service listening on ${port}`);
});
