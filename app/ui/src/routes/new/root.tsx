import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../../services/api";
import { useMutation } from "@tanstack/react-query";
import { BotForm } from "../../components/Common/BotForm";
import { Form, notification, Skeleton } from "antd";
import axios from "axios";
import { useCreateConfig } from "../../hooks/useCreateConfig";

export default function NewRoot() {
  const { data: botConfig, status: botConfigStatus } = useCreateConfig();

  const navigate = useNavigate();
  const [selectedSource, setSelectedSource] = useState<any>({
    id: 1,
    value: "Website",
  });
  const [form] = Form.useForm();
  const onSubmit = async (values: any) => {
    if (selectedSource.id == 2 || selectedSource.id == 5) {
      const formData = new FormData();
      values.file.forEach((file: any) => {
        formData.append("file", file.originFileObj);
      });
      const response = await api.post(
        `/bot/upload?embedding=${values.embedding}&model=${values.model}`,
        formData,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        }
      );
      return response.data;
    }
    const response = await api.post("/bot", {
      type: selectedSource.value.toLowerCase(),
      ...values,
    });
    return response.data;
  };
  const { mutateAsync: createBot, isLoading } = useMutation(onSubmit, {
    onSuccess: (data: any) => {
      navigate(`/bot/${data.id}`);
    },
    onError: (e) => {
      console.log(e);
      if (axios.isAxiosError(e)) {
        const message =
          e.response?.data?.message ||
          e?.response?.data?.error ||
          "Something went wrong.";
        notification.error({
          message: "Error",
          description: message,
        });
        return;
      }

      notification.error({
        message: "Error",
        description: "Something went wrong.",
      });
    },
  });

  return (
    <>
      <div className="flex min-h-full flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <h2 className="mt-6 text-center text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
            Create a new bot
          </h2>
        </div>
        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-lg">
          <div className="bg-white py-8 px-4 border sm:rounded-lg sm:px-10 dark:bg-[#171717] dark:border-gray-600">
            {botConfigStatus === "success" && (
              <BotForm
                botConfig={botConfig}
                showEmbeddingAndModels={true}
                createBot={createBot}
                isLoading={isLoading}
                setSelectedSource={setSelectedSource}
                form={form}
              />
            )}
            {botConfigStatus === "error" && (
              <div>Something went wrong while fetching config</div>
            )}
            {botConfigStatus === "loading" && (
              <div className="flex justify-center items-center">
                <Skeleton active paragraph={{ rows: 5 }} />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
