import { Configuration, OpenAIApi } from "openai";
import { logger } from './logger';
import env from './env';

class gpt3Request {
    configuration: any;
    openai: any;
    
    async init() {
        this.configuration = new Configuration({
            apiKey: env.OPENAI_API_KEY,
          });
        this.openai = new OpenAIApi(this.configuration);

        await this.request("This is a test, answer an json object like {'message': 'ok'} if you can read this.")
        .then((response) => {
        }).catch((error) => {
            logger.error(`Error during the initialisation of gpt3Request: ${error}`);
            logger.debug(error.response.status);
            logger.debug(error.response.data);
            logger.debug(error.message);
        });
    }

    async request(text: string): Promise<string> {
        const completion = await this.openai.createCompletion({
            model: "text-davinci-003",
            prompt: text,
          });

        logger.debug("GPT3Request respond");
        logger.debug(text);
        logger.debug(completion.data.choices[0].text.match(/{([^}]+)}/)[0])
        return completion.data.choices[0].text;
    }
}

export default gpt3Request;
