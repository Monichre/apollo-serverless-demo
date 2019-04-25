// tslint:disable:interface-name completed-docs ban-types object-literal-sort-keys
import {
  DocumentNode,
  ExecutionResult,
  GraphQLFieldResolver,
  GraphQLSchema,
  parse,
  specifiedRules,
  validate,
  ValidationContext,
} from "graphql";
import { IncomingMessage } from "http";
import { createAsyncIterator, forAwaitEach, isAsyncIterable } from "iterall";
import WebSocket from "ws";
import { parseLegacyProtocolMessage } from "./legacy/parse-legacy-protocol";
import MessageTypes from "./message-types";
import { GRAPHQL_SUBSCRIPTIONS, GRAPHQL_WS } from "./protocol";
import { ISubscriptionServerExecutionParams } from "./types";
import { createEmptyIterable } from "./utils/empty-iterable";
import isObject from "./utils/is-object";
import { isASubscriptionOperation } from "./utils/is-subscriptions";

export type ExecutionIterator = AsyncIterator<ExecutionResult>;

export enum SocketReadyState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

export interface SubscriptionSocket extends Partial<WebSocket> {
  protocol: string;
  readyState: SocketReadyState;
  close(code?: number, data?: string): void;
  on(eventName: string, eventHandler: Function): any;
  send(message: string): void;
}

export interface ConnectionContext {
  initPromise: Promise<any>;
  isLegacy: boolean;
  socket: SubscriptionSocket;
  request: IncomingMessage;
  operations: {
    [opId: string]: ExecutionIterator;
  };
}

export interface OperationMessagePayload {
  [key: string]: any; // this will support for example any options sent in init like the auth token
  query?: string;
  variables?: { [key: string]: any };
  operationName?: string;
}

export interface OperationMessage {
  payload?: OperationMessagePayload;
  id?: string;
  type: string;
}

export type ExecuteFunction = (
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: any,
  contextValue?: any,
  variableValues?: { [key: string]: any },
  operationName?: string,
  fieldResolver?: GraphQLFieldResolver<any, any>,
) =>
  | ExecutionResult
  | Promise<ExecutionResult>
  | AsyncIterator<ExecutionResult>;

export type SubscribeFunction = (
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: any,
  contextValue?: any,
  variableValues?: { [key: string]: any },
  operationName?: string,
  fieldResolver?: GraphQLFieldResolver<any, any>,
  subscribeFieldResolver?: GraphQLFieldResolver<any, any>,
) =>
  | AsyncIterator<ExecutionResult>
  | Promise<AsyncIterator<ExecutionResult> | ExecutionResult>;

export interface ServerOptions {
  rootValue?: any;
  schema?: GraphQLSchema;
  execute?: ExecuteFunction;
  subscribe?: SubscribeFunction;
  validationRules?:
    | Array<(context: ValidationContext) => any>
    | ReadonlyArray<any>;
  onOperation?: Function;
  onOperationComplete?: Function;
  onConnect?: Function;
  onDisconnect?: Function;
  keepAlive?: number;
}

const NotImplementedMethod = (methodName: string) => (...args: any[]) => {
  throw new Error(`method ${methodName} is not implemented.`);
};

export class SocketSubscriptionServer {
  private onOperation: Function;
  private onOperationComplete: Function;
  private onConnect: Function;
  private onDisconnect: Function;

  private execute: ExecuteFunction;
  private subscribe?: SubscribeFunction;
  private schema?: GraphQLSchema;
  private rootValue: any;
  private keepAlive: number | undefined;
  private closeHandler: () => void;
  private specifiedRules:
    | Array<(context: ValidationContext) => any>
    | ReadonlyArray<any>;

  constructor(options: ServerOptions) {
    const {
      onOperation,
      onOperationComplete,
      onConnect,
      onDisconnect,
      keepAlive,
    } = options;
    this.specifiedRules = options.validationRules || specifiedRules;
    this.loadExecutor(options);
    this.onOperation = onOperation || NotImplementedMethod("onOperation");
    this.onOperationComplete =
      onOperationComplete || NotImplementedMethod("onOperationComplete");
    this.onConnect = onConnect || NotImplementedMethod("onConnect");
    this.onDisconnect = onDisconnect || NotImplementedMethod("onDisconnect");
    this.keepAlive = keepAlive;
  }

  public handleConnection(socket: SubscriptionSocket): void {
    // NOTE: the old GRAPHQL_SUBSCRIPTIONS protocol support should be removed in the future
    if (
      socket.protocol === undefined ||
      (socket.protocol.indexOf(GRAPHQL_WS) === -1 &&
        socket.protocol.indexOf(GRAPHQL_SUBSCRIPTIONS) === -1)
    ) {
      // Close the connection with an error code, ws v2 ensures that the
      // connection is cleaned up even when the closing handshake fails.
      // 1002: protocol error
      socket.close(1002);

      return;
    }

    const connectionContext: ConnectionContext = Object.create(null);
    connectionContext.initPromise = Promise.resolve(true);
    connectionContext.isLegacy = false;
    connectionContext.socket = socket;
    connectionContext.operations = {};

    const connectionClosedHandler = (error: any) => {
      if (error) {
        this.sendError(
          connectionContext,
          undefined,
          { message: error.message ? error.message : error },
          MessageTypes.GQL_CONNECTION_ERROR,
        );

        setTimeout(() => {
          // 1011 is an unexpected condition prevented the request from being fulfilled
          connectionContext.socket.close(1011);
        }, 10);
      }
      this.onClose(connectionContext);

      if (this.onDisconnect) {
        this.onDisconnect(socket, connectionContext);
      }
    };

    socket.on("error", connectionClosedHandler);
    socket.on("close", connectionClosedHandler);
    socket.on("message", this.onMessage(connectionContext));
  }

  private loadExecutor(options: ServerOptions) {
    const { execute, subscribe, schema, rootValue } = options;

    if (!execute) {
      throw new Error(
        "Must provide `execute` for websocket server constructor.",
      );
    }

    this.schema = schema;
    this.rootValue = rootValue;
    this.execute = execute;
    this.subscribe = subscribe;
  }

  private unsubscribe(connectionContext: ConnectionContext, opId: string) {
    const operation =
      opId in connectionContext.operations
        ? connectionContext.operations[opId]
        : undefined;
    if (!operation) {
      return;
    }
    if (typeof operation.return === "function") {
      operation.return();
    }
    delete connectionContext.operations[opId];
    if (this.onOperationComplete) {
      this.onOperationComplete(connectionContext.socket, opId);
    }
  }

  private onClose(connectionContext: ConnectionContext) {
    Object.keys(connectionContext.operations).forEach(opId => {
      this.unsubscribe(connectionContext, opId);
    });
  }

  private onMessage(connectionContext: ConnectionContext) {
    return (message: any) => {
      let parsedMessage: OperationMessage;
      try {
        parsedMessage = parseLegacyProtocolMessage(
          connectionContext,
          JSON.parse(message),
        );
      } catch (e) {
        this.sendError(
          connectionContext,
          undefined,
          { message: e.message },
          MessageTypes.GQL_CONNECTION_ERROR,
        );
        return;
      }

      const opId = parsedMessage.id;
      switch (parsedMessage.type) {
        case MessageTypes.GQL_CONNECTION_INIT:
          if (this.onConnect) {
            connectionContext.initPromise = new Promise((resolve, reject) => {
              try {
                // TODO - this should become a function call with just 2 arguments in the future
                // when we release the breaking change api: parsedMessage.payload and connectionContext
                resolve(
                  this.onConnect(
                    parsedMessage.payload,
                    connectionContext.socket,
                    connectionContext,
                  ),
                );
              } catch (e) {
                reject(e);
              }
            });
          }

          connectionContext.initPromise
            .then(result => {
              if (result === false) {
                throw new Error("Prohibited connection!");
              }

              this.sendMessage(
                connectionContext,
                undefined,
                MessageTypes.GQL_CONNECTION_ACK,
                undefined,
              );

              if (this.keepAlive) {
                this.sendKeepAlive(connectionContext);
                // Regular keep alive messages if keepAlive is set
                const keepAliveTimer = setInterval(() => {
                  if (
                    connectionContext.socket.readyState ===
                    SocketReadyState.OPEN
                  ) {
                    this.sendKeepAlive(connectionContext);
                  } else {
                    clearInterval(keepAliveTimer);
                  }
                }, this.keepAlive);
              }
            })
            .catch((error: Error) => {
              this.sendError(
                connectionContext,
                opId,
                { message: error.message },
                MessageTypes.GQL_CONNECTION_ERROR,
              );

              // Close the connection with an error code, ws v2 ensures that the
              // connection is cleaned up even when the closing handshake fails.
              // 1011: an unexpected condition prevented the operation from being fulfilled
              // We are using setTimeout because we want the message to be flushed before
              // disconnecting the client
              setTimeout(() => {
                connectionContext.socket.close(1011);
              }, 10);
            });
          break;

        case MessageTypes.GQL_CONNECTION_TERMINATE:
          connectionContext.socket.close();
          break;

        case MessageTypes.GQL_START:
          connectionContext.initPromise
            .then(initResult => {
              // if we already have a subscription with this id, unsubscribe from it first
              if (
                typeof opId !== "undefined" &&
                connectionContext.operations &&
                connectionContext.operations[opId]
              ) {
                this.unsubscribe(connectionContext, opId);
              }

              const { payload } = parsedMessage;
              if (!payload) {
                throw new Error(
                  `Failed to parse payload from Message: ${message}`,
                );
              }
              if (!payload.query) {
                throw new Error(
                  `Failed to parse query from Message: ${message}`,
                );
              }
              const baseParams: ISubscriptionServerExecutionParams = {
                query: payload.query,
                variables: payload.variables || {},
                operationName: payload.operationName,
                context: isObject(initResult)
                  ? Object.assign(
                      Object.create(Object.getPrototypeOf(initResult)),
                      initResult,
                    )
                  : {},
                formatResponse: undefined as any,
                formatError: undefined as any,
                callback: undefined as any,
                schema: this.schema,
              };
              let promisedParams = Promise.resolve(baseParams);

              if (opId) {
                // set an initial mock subscription to only registering opId
                connectionContext.operations[opId] = createEmptyIterable();
              }

              if (this.onOperation) {
                const messageForCallback: any = parsedMessage;
                promisedParams = Promise.resolve(
                  this.onOperation(
                    messageForCallback,
                    baseParams,
                    connectionContext.socket,
                  ),
                );
              }

              promisedParams
                .then(params => {
                  if (typeof params !== "object") {
                    const error = `Invalid params returned from onOperation! return values must be an object!`;
                    this.sendError(connectionContext, opId, { message: error });

                    throw new Error(error);
                  }

                  if (!params.schema) {
                    const error =
                      "Missing schema information. The GraphQL schema should be provided either statically in" +
                      " the `SubscriptionServer` constructor or as a property on the object returned from onOperation!";
                    this.sendError(connectionContext, opId, { message: error });

                    throw new Error(error);
                  }

                  const document =
                    typeof baseParams.query !== "string"
                      ? baseParams.query
                      : parse(baseParams.query);
                  let executionPromise: Promise<
                    AsyncIterator<ExecutionResult> | ExecutionResult
                  >;
                  const validationErrors = validate(
                    params.schema,
                    document,
                    this.specifiedRules,
                  );

                  if (validationErrors.length > 0) {
                    executionPromise = Promise.resolve({
                      errors: validationErrors,
                    });
                  } else {
                    let executor: SubscribeFunction | ExecuteFunction = this
                      .execute;
                    if (
                      this.subscribe &&
                      isASubscriptionOperation(document, params.operationName)
                    ) {
                      executor = this.subscribe;
                    }
                    executionPromise = Promise.resolve(
                      executor(
                        params.schema,
                        document,
                        this.rootValue,
                        params.context,
                        params.variables,
                        params.operationName,
                      ),
                    );
                  }

                  return executionPromise.then(executionResult => ({
                    executionIterable: isAsyncIterable(executionResult)
                      ? executionResult
                      : createAsyncIterator([executionResult]),
                    params,
                  }));
                })
                .then(({ executionIterable, params }) => {
                  forAwaitEach(
                    executionIterable as any,
                    (value: ExecutionResult) => {
                      let result = value;

                      if (params.formatResponse) {
                        try {
                          result = params.formatResponse(value, params);
                        } catch (err) {
                          console.error("Error in formatError function:", err);
                        }
                      }

                      this.sendMessage(
                        connectionContext,
                        opId,
                        MessageTypes.GQL_DATA,
                        result,
                      );
                    },
                  )
                    .then(() => {
                      this.sendMessage(
                        connectionContext,
                        opId,
                        MessageTypes.GQL_COMPLETE,
                        null,
                      );
                    })
                    .catch((e: Error) => {
                      let error = e;

                      if (params.formatError) {
                        try {
                          error = params.formatError(e, params);
                        } catch (err) {
                          console.error("Error in formatError function: ", err);
                        }
                      }

                      // plain Error object cannot be JSON stringified.
                      if (Object.keys(e).length === 0) {
                        error = { name: e.name, message: e.message };
                      }

                      this.sendError(connectionContext, opId, error);
                    });

                  return executionIterable;
                })
                .then((subscription: ExecutionIterator) => {
                  if (opId) {
                    connectionContext.operations[opId] = subscription;
                  }
                })
                .then(() => {
                  // NOTE: This is a temporary code to support the legacy protocol.
                  // As soon as the old protocol has been removed, this coode should also be removed.
                  this.sendMessage(
                    connectionContext,
                    opId,
                    MessageTypes.SUBSCRIPTION_SUCCESS,
                    undefined,
                  );
                })
                .catch((e: any) => {
                  if (e.errors) {
                    this.sendMessage(
                      connectionContext,
                      opId,
                      MessageTypes.GQL_DATA,
                      { errors: e.errors },
                    );
                  } else {
                    this.sendError(connectionContext, opId, {
                      message: e.message,
                    });
                  }

                  // Remove the operation on the server side as it will be removed also in the client
                  if (opId) {
                    this.unsubscribe(connectionContext, opId);
                  }
                  return;
                });
              return promisedParams;
            })
            .catch(error => {
              // Handle initPromise rejected
              this.sendError(connectionContext, opId, {
                message: error.message,
              });
              if (opId) {
                this.unsubscribe(connectionContext, opId);
              }
            });
          break;

        case MessageTypes.GQL_STOP:
          // Find subscription id. Call unsubscribe.
          if (opId) {
            this.unsubscribe(connectionContext, opId);
          }
          break;

        default:
          this.sendError(connectionContext, opId, {
            message: "Invalid message type!",
          });
      }
    };
  }

  private sendKeepAlive(connectionContext: ConnectionContext): void {
    if (connectionContext.isLegacy) {
      this.sendMessage(
        connectionContext,
        undefined,
        MessageTypes.KEEP_ALIVE,
        undefined,
      );
    } else {
      this.sendMessage(
        connectionContext,
        undefined,
        MessageTypes.GQL_CONNECTION_KEEP_ALIVE,
        undefined,
      );
    }
  }

  private sendMessage(
    connectionContext: ConnectionContext,
    opId: string | undefined,
    type: string,
    payload: any,
  ): void {
    const parsedMessage = parseLegacyProtocolMessage(connectionContext, {
      type,
      id: opId,
      payload,
    });

    if (
      parsedMessage &&
      connectionContext.socket.readyState === SocketReadyState.OPEN
    ) {
      connectionContext.socket.send(JSON.stringify(parsedMessage));
    }
  }

  private sendError(
    connectionContext: ConnectionContext,
    opId: string | undefined,
    errorPayload: any,
    overrideDefaultErrorType?: string,
  ): void {
    const sanitizedOverrideDefaultErrorType =
      overrideDefaultErrorType || MessageTypes.GQL_ERROR;
    if (
      [MessageTypes.GQL_CONNECTION_ERROR, MessageTypes.GQL_ERROR].indexOf(
        sanitizedOverrideDefaultErrorType,
      ) === -1
    ) {
      throw new Error(
        "overrideDefaultErrorType should be one of the allowed error messages" +
          " GQL_CONNECTION_ERROR or GQL_ERROR",
      );
    }

    this.sendMessage(
      connectionContext,
      opId,
      sanitizedOverrideDefaultErrorType,
      errorPayload,
    );
  }
}
