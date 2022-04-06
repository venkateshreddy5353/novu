import * as open from 'open';
import { Answers } from 'inquirer';
import * as ora from 'ora';
import { IEnvironment, ICreateNotificationTemplateDto } from '@novu/shared';
import { prompt } from '../client';
import {
  environmentQuestions,
  existingSessionQuestions,
  introQuestions,
  registerMethodQuestions,
  showWelcomeScreen,
} from './init.consts';
import { HttpServer } from '../server';
import {
  SERVER_HOST,
  REDIRECT_ROUTE,
  API_OAUTH_URL,
  WIDGET_DEMO_ROUTH,
  API_TRIGGER_URL,
  CLIENT_LOGIN_URL,
  getServerPort,
  GITHUB_DOCKER_URL,
} from '../constants';
import {
  storeHeader,
  createOrganization,
  switchOrganization,
  createEnvironment,
  getEnvironmentMe,
  switchEnvironment,
  getNotificationGroup,
  createNotificationTemplates,
  getEnvironmentApiKeys,
} from '../api';
import { ConfigService } from '../services';

export enum ChannelTypeEnum {
  IN_APP = 'in_app',
  EMAIL = 'email',
  SMS = 'sms',
}

export enum ChannelCTATypeEnum {
  REDIRECT = 'redirect',
}

export async function initCommand() {
  try {
    await showWelcomeScreen();

    const config = new ConfigService();
    if (process.env.NODE_ENV === 'dev') {
      await config.clearStore();
    }

    const existingEnvironment = await checkExistingEnvironment(config);
    if (existingEnvironment) {
      const { result } = await prompt(existingSessionQuestions(existingEnvironment));

      if (result === 'visitDashboard') {
        await handleExistingSession(result, config);

        return;
      }
      process.exit();
    }

    await handleOnboardingFlow(config);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
  }
}

async function handleOnboardingFlow(config: ConfigService) {
  const httpServer = new HttpServer();

  await httpServer.listen();

  let spinner: ora.Ora = null;

  try {
    const answers = await prompt(introQuestions);

    const envAnswer = await prompt(environmentQuestions);
    if (envAnswer.env === 'self-hosted-docker') {
      await open(GITHUB_DOCKER_URL);

      return;
    }

    const regMethod = await prompt(registerMethodQuestions);

    if (regMethod.value === 'github') {
      spinner = ora('Waiting for a brave unicorn to login').start();
      await gitHubOAuth(httpServer, config);
      spinner.stop();
    }

    spinner = ora('Setting up your new account').start();

    await createOrganizationHandler(config, answers);
    const environmentIdentifier = await createEnvironmentHandler(config, answers);

    const address = httpServer.getAddress();

    spinner.succeed(`Created your account successfully. 
    
  We've created a demo web page for you to see novu notifications in action.
  Visit: ${address}/demo to continue`);

    await raiseDemoDashboard(httpServer, config, environmentIdentifier);
    await exitHandler();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);
    spinner?.fail('Something un-expected happened :(');
  } finally {
    spinner?.stop();
    httpServer.close();
  }
}

async function gitHubOAuth(httpServer: HttpServer, config: ConfigService): Promise<void> {
  const redirectUrl = `http://${SERVER_HOST}:${await getServerPort()}${REDIRECT_ROUTE}`;

  try {
    await open(`${API_OAUTH_URL}?&redirectUrl=${redirectUrl}`);

    const userJwt = await httpServer.redirectResponse();

    storeToken(config, userJwt);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);
  }
}

async function createOrganizationHandler(config: ConfigService, answers: Answers) {
  if (config.isOrganizationIdExist()) return;

  const createOrganizationResponse = await createOrganization(answers.environmentName);

  const newUserJwt = await switchOrganization(createOrganizationResponse._id);

  storeToken(config, newUserJwt);
}

async function createEnvironmentHandler(config: ConfigService, answers: Answers): Promise<string> {
  if (config.isEnvironmentIdExist()) {
    const existingEnvironment = await getEnvironmentMe();
    const keys = await getEnvironmentApiKeys();

    config.setValue('apiKey', keys[0]?.key);

    return existingEnvironment.identifier;
  }

  const createEnvironmentResponse = await createEnvironment(answers.environmentName);
  const newUserJwt = await switchEnvironment(createEnvironmentResponse._id);

  config.setValue('apiKey', createEnvironmentResponse.apiKeys[0].key);
  storeToken(config, newUserJwt);

  return createEnvironmentResponse.identifier;
}

async function raiseDemoDashboard(httpServer: HttpServer, config: ConfigService, environmentIdentifier: string) {
  const notificationGroupResponse = await getNotificationGroup();

  const template = buildTemplate(notificationGroupResponse[0]._id);
  const createNotificationTemplatesResponse = await createNotificationTemplates(template);

  const decodedToken = config.getDecodedToken();
  const demoDashboardUrl = await getDemoDashboardUrl();

  storeDashboardData(config, createNotificationTemplatesResponse, decodedToken, environmentIdentifier);

  httpServer.redirectSuccessDashboard(demoDashboardUrl);
}

function buildTemplate(notificationGroupId: string): ICreateNotificationTemplateDto {
  const redirectUrl = `${CLIENT_LOGIN_URL}?token={{token}}`;

  const messages = [
    {
      type: ChannelTypeEnum.IN_APP,
      content:
        'Welcome <b>{{$first_name}}</b>! This is your first notification, click on it to visit your live dashboard',
      cta: {
        type: ChannelCTATypeEnum.REDIRECT,
        data: {
          url: redirectUrl,
        },
      },
    },
  ];

  return {
    notificationGroupId,
    name: 'On-boarding notification',
    active: true,
    draft: false,
    messages,
    tags: null,
    description: null,
  };
}

async function getDemoDashboardUrl() {
  return `http://${SERVER_HOST}:${await getServerPort()}${WIDGET_DEMO_ROUTH}`;
}

function storeDashboardData(
  config: ConfigService,
  createNotificationTemplatesResponse,
  decodedToken,
  environmentIdentifier: string
) {
  const dashboardURL = `${CLIENT_LOGIN_URL}?token=${config.getToken()}`;

  const tmpPayload: { key: string; value: string }[] = [
    { key: 'url', value: API_TRIGGER_URL },
    { key: 'apiKey', value: config.getValue('apiKey') },
    { key: 'name', value: createNotificationTemplatesResponse.triggers[0].identifier },
    { key: '$user_id', value: decodedToken._id },
    { key: '$first_name', value: decodedToken.firstName },
    { key: '$last_name', value: decodedToken.lastName },
    { key: '$email', value: decodedToken.email },
    { key: 'environmentId', value: environmentIdentifier },
    { key: 'token', value: config.getToken() },
    { key: 'dashboardURL', value: dashboardURL },
  ];

  config.setValue('triggerPayload', JSON.stringify(tmpPayload));
}

/*
 * Stores token in config and axios default headers
 */
function storeToken(config: ConfigService, userJwt: string) {
  config.setValue('token', userJwt);
  storeHeader('authorization', `Bearer ${config.getToken()}`);
}

async function exitHandler(): Promise<void> {
  await keyPress();
}

const keyPress = async (): Promise<void> => {
  return new Promise((resolve) =>
    process.stdin.once('data', () => {
      resolve();
    })
  );
};

async function checkExistingEnvironment(config: ConfigService): Promise<IEnvironment | null> {
  const isSessionExists = !!config.getDecodedToken();

  if (isSessionExists && process.env.NODE_ENV !== 'dev') {
    storeToken(config, config.getToken());

    let existingEnvironment: IEnvironment;

    try {
      existingEnvironment = await getEnvironmentMe();
      if (!existingEnvironment) {
        return null;
      }
    } catch (e) {
      await config.clearStore();

      return null;
    }

    return existingEnvironment;
  }

  return null;
}

async function handleExistingSession(result: string, config: ConfigService) {
  if (result === 'visitDashboard') {
    const dashboardURL = `${CLIENT_LOGIN_URL}?token=${config.getToken()}`;

    await open(dashboardURL);
  } else if (result === 'exit') {
    process.exit();
  }
}
