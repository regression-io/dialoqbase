import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Document } from "@langchain/core/documents";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
  PromptTemplate,
} from "@langchain/core/prompts";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  Runnable,
  RunnableBranch,
  RunnableLambda,
  RunnableMap,
  RunnableSequence,
} from "@langchain/core/runnables";

type RetrievalChainInput = {
  chat_history: string;
  question: string;
};

const updateTemplateVariables = (template: string) => {
  // replace template {time} with current time
  template = template.replace("{time}", new Date().toLocaleTimeString());
  // replace template {date} with current date
  template = template.replace("{date}", new Date().toLocaleDateString());
  // replace template {day} with current day
  template = template.replace("{day}", new Date().toLocaleString('en-us', { weekday: 'long' }));

  return template;
}

export function groupMessagesByConversation(messages: any[]) {
  // check if messages are in even numbers if not remove the last message
  if (messages.length % 2 !== 0) {
    messages.pop();
  }

  const groupedMessages = [];
  // [ { human: "", ai: "" } ]
  for (let i = 0; i < messages.length; i += 2) {
    groupedMessages.push({
      human: messages[i].content,
      ai: messages[i + 1].content,
    });
  }

  return groupedMessages;
}

const formatChatHistoryAsString = (history: BaseMessage[]) => {
  return history
    .map((message) => `${message._getType()}: ${message.content}`)
    .join("\n");
};

const formatDocs = (docs: Document[]) => {
  return docs
    .map((doc, i) => `<doc id='${i}'>${doc.pageContent}</doc>`)
    .join("\n");
};

const serializeHistory = (input: any) => {
  const chatHistory = input.chat_history || [];
  const convertedChatHistory = [];
  for (const message of chatHistory) {
    if (message.human !== undefined) {
      convertedChatHistory.push(new HumanMessage({ content: message.human }));
    }
    if (message["ai"] !== undefined) {
      convertedChatHistory.push(new AIMessage({ content: message.ai }));
    }
  }
  return convertedChatHistory;
};

const createRetrieverChain = (
  llm: BaseLanguageModel,
  retriever: Runnable,
  question_template: string
) => {
  const CONDENSE_QUESTION_PROMPT =
    PromptTemplate.fromTemplate(question_template);
  const condenseQuestionChain = RunnableSequence.from([
    CONDENSE_QUESTION_PROMPT,
    llm,
    new StringOutputParser(),
  ]).withConfig({
    runName: "CondenseQuestion",
  });
  const hasHistoryCheckFn = RunnableLambda.from(
    (input: RetrievalChainInput) => input.chat_history.length > 0
  ).withConfig({ runName: "HasChatHistoryCheck" });
  const conversationChain = condenseQuestionChain.pipe(retriever).withConfig({
    runName: "RetrievalChainWithHistory",
  });
  const basicRetrievalChain = RunnableLambda.from(
    (input: RetrievalChainInput) => input.question
  )
    .withConfig({
      runName: "Itemgetter:question",
    })
    .pipe(retriever)
    .withConfig({ runName: "RetrievalChainWithNoHistory" });

  return RunnableBranch.from([
    [hasHistoryCheckFn, conversationChain],
    basicRetrievalChain,
  ]).withConfig({
    runName: "FindDocs",
  });
};

export const createChain = ({
  llm,
  question_template,
  question_llm,
  retriever,
  response_template,
}: {
  llm: BaseLanguageModel<any> | BaseChatModel<any>;
  question_llm: BaseLanguageModel<any> | BaseChatModel<any>;
  retriever: Runnable;
  question_template: string;
  response_template: string;
}) => {

  question_template = updateTemplateVariables(question_template);
  
  response_template = updateTemplateVariables(response_template);

  const retrieverChain = createRetrieverChain(
    question_llm,
    retriever,
    question_template
  );
  const context = RunnableMap.from({
    context: RunnableSequence.from([
      ({ question, chat_history }) => {
        return {
          question: question,
          chat_history: formatChatHistoryAsString(chat_history),
        };
      },
      retrieverChain,
      RunnableLambda.from(formatDocs).withConfig({
        runName: "FormatDocumentChunks",
      }),
    ]),
    question: RunnableLambda.from(
      (input: RetrievalChainInput) => input.question
    ).withConfig({
      runName: "Itemgetter:question",
    }),
    chat_history: RunnableLambda.from(
      (input: RetrievalChainInput) => input.chat_history
    ).withConfig({
      runName: "Itemgetter:chat_history",
    }),
  }).withConfig({ tags: ["RetrieveDocs"] });
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", response_template],
    new MessagesPlaceholder("chat_history"),
    ["human", "{question}"],
  ]);

  const responseSynthesizerChain = RunnableSequence.from([
    prompt,
    llm,
    new StringOutputParser(),
  ]).withConfig({
    tags: ["GenerateResponse"],
  });
  return RunnableSequence.from([
    {
      question: RunnableLambda.from(
        (input: RetrievalChainInput) => input.question
      ).withConfig({
        runName: "Itemgetter:question",
      }),
      chat_history: RunnableLambda.from(serializeHistory).withConfig({
        runName: "SerializeHistory",
      }),
    },
    context,
    responseSynthesizerChain,
  ]);
};
