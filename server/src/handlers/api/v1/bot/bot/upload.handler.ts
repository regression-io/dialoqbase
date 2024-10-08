import { FastifyReply, FastifyRequest } from "fastify";
import {
  adjectives,
  animals,
  colors,
  uniqueNamesGenerator,
} from "unique-names-generator";

import { AddNewPDFById, UploadPDF } from "./types";
import * as fs from "fs";
import * as util from "util";
import { pipeline } from "stream";
import { randomUUID } from "crypto";
import {
  apiKeyValidaton,
  apiKeyValidatonMessage,
} from "../../../../../utils/validate";
const pump = util.promisify(pipeline);
import { fileTypeFinder } from "../../../../../utils/fileType";
import { getSettings } from "../../../../../utils/common";
import { HELPFUL_ASSISTANT_WITH_CONTEXT_PROMPT } from "../../../../../utils/prompts";
import { getModelInfo } from "../../../../../utils/get-model-info";

export const createBotFileHandler = async (
  request: FastifyRequest<UploadPDF>,
  reply: FastifyReply
) => {
  try {
    const embedding = request.query.embedding;
    const model = request.query.model;
    const prisma = request.server.prisma;
    // only non-admin users are affected by this settings
    const settings = await getSettings(prisma);
    const user = request.user;
    const isBotCreatingAllowed = settings?.allowUserToCreateBots;
    if (!user.is_admin && !isBotCreatingAllowed) {
      return reply.status(400).send({
        message: "Bot creation is disabled by admin",
      });
    }

    const totalBotsUserCreated = await prisma.bot.count({
      where: {
        user_id: request.user.user_id,
      },
    });

    const maxBotsAllowed = settings?.noOfBotsPerUser || 10;

    if (!user.is_admin && totalBotsUserCreated >= maxBotsAllowed) {
      return reply.status(400).send({
        message: `Reach maximum limit of ${maxBotsAllowed} bots per user`,
      });
    }

    const embeddingInfo = await getModelInfo({
      model: embedding,
      prisma,
      type: "embedding",
    });

    if (!embeddingInfo) {
      return reply.status(400).send({
        message: "Model not found",
      });
    }

    const isEmbeddingsValid = apiKeyValidaton(
      `${embeddingInfo.model_provider}`.toLowerCase()
    );

    if (!isEmbeddingsValid) {
      return reply.status(400).send({
        message: apiKeyValidatonMessage(embedding),
      });
    }

    const modelInfo = await getModelInfo({
      model,
      prisma,
      type: "chat",
    });

    if (!modelInfo) {
      return reply.status(400).send({
        message: "Model not found",
      });
    }

    const isAPIKeyAddedForProvider = apiKeyValidaton(
      `${modelInfo.model_provider}`.toLocaleLowerCase()
    );

    if (!isAPIKeyAddedForProvider) {
      return reply.status(400).send({
        message: apiKeyValidatonMessage(
          `${modelInfo.model_provider}`.toLocaleLowerCase()
        ),
      });
    }

    const name = uniqueNamesGenerator({
      dictionaries: [adjectives, animals, colors],
      length: 2,
    });

    const isStreamingAvilable = modelInfo.stream_available;

    const bot = await prisma.bot.create({
      data: {
        name,
        embedding,
        model,
        provider: modelInfo.model_provider || "",
        streaming: isStreamingAvilable,
        user_id: request.user.user_id,
      },
    });

    const files = request.files();

    for await (const file of files) {
      const fileName = `${randomUUID()}-${file.filename}`;
      const path = `./uploads/${fileName}`;
      await fs.promises.mkdir("./uploads", { recursive: true });
      await pump(
        file.file,
        fs.createWriteStream(path) as any
      );
      const type = fileTypeFinder(file.mimetype);

      const botSource = await prisma.botSource.create({
        data: {
          content: file.filename,
          type,
          botId: bot.id,
          location: path,
        },
      });

      await request.server.queue.add(
        "process",
        [
          {
            ...botSource,
            embedding: bot.embedding,
          },
        ],
        {
          jobId: botSource.id,
          removeOnComplete: true,
          removeOnFail: true,
        }
      );
    }

    return reply.status(200).send({
      id: bot.id,
    });
  } catch (err) {
    console.log(err);
    return reply.status(500).send({
      message: "Upload failed due to internal server error",
    });
  }
};

export const addNewSourceFileByIdHandler = async (
  request: FastifyRequest<AddNewPDFById>,
  reply: FastifyReply
) => {
  const prisma = request.server.prisma;
  const id = request.params.id;

  const bot = await prisma.bot.findFirst({
    where: {
      id,
      user_id: request.user.user_id,
    },
    include: {
      source: true,
    },
  });

  if (!bot) {
    return reply.status(404).send({
      message: "Bot not found",
    });
  }

  const files = request.files();

  for await (const file of files) {
    const fileName = `${randomUUID()}-${file.filename}`;
    const path = `./uploads/${fileName}`;
    await fs.promises.mkdir("./uploads", { recursive: true });
    await pump(file.file, fs.createWriteStream(path) as any);
    const type = fileTypeFinder(file.mimetype);

    const botSource = await prisma.botSource.create({
      data: {
        content: file.filename,
        type,
        location: path,
        botId: id,
      },
    });

    if (bot.source.length === 0 && !bot.haveDataSourcesBeenAdded) {
      await prisma.bot.update({
        where: {
          id,
        },
        data: {
          haveDataSourcesBeenAdded: true,
          qaPrompt: HELPFUL_ASSISTANT_WITH_CONTEXT_PROMPT,
        },
      });
    }

    await request.server.queue.add(
      "process",
      [
        {
          ...botSource,
          embedding: bot.embedding,
        },
      ],
      {
        jobId: botSource.id,
        removeOnComplete: true,
        removeOnFail: true,
      }
    );
  }

  return {
    id: bot.id,
  };
};

export const addNewSourceFileByIdBulkHandler = async (
  request: FastifyRequest<AddNewPDFById>,
  reply: FastifyReply
) => {
  try {
    const prisma = request.server.prisma;
    const id = request.params.id;

    const bot = await prisma.bot.findFirst({
      where: {
        id,
        user_id: request.user.user_id,
      },
      include: {
        source: true,
      },
    });

    if (!bot) {
      return reply.status(404).send({
        message: "Bot not found",
      });
    }

    const files = request.files();
    const queueSource: any[] = [];

    for await (const file of files) {
      const type = fileTypeFinder(file.mimetype);
      if (type === "none") {
        return reply.status(400).send({
          message: "File type not supported or invalid file type",
        });
      }
      const fileName = `${randomUUID()}-${file.filename}`;
      const path = `./uploads/${fileName}`;
      await fs.promises.mkdir("./uploads", { recursive: true });
      await pump(file.file, fs.createWriteStream(path) as any);

      const botSource = await prisma.botSource.create({
        data: {
          content: file.filename,
          type,
          location: path,
          botId: id,
        },
      });

      queueSource.push({
        ...botSource,
        embedding: bot.embedding,
        id: botSource.id,
      });
    }

    await request.server.queue.addBulk(
      queueSource.map((source) => ({
        data: [source],
        name: "process",
        opts: {
          jobId: source.id,
          removeOnComplete: true,
          removeOnFail: true,
        },
      }))
    );

    return {
      source_ids: queueSource.map((source) => source.id),
      success: true,
    };
  } catch (err) {
    console.log(err);
    return reply.status(500).send({
      message: "Upload failed due to internal server error",
    });
  }
};
