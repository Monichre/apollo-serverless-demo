import * as pulumiAws from "@pulumi/aws";
import * as pulumiAwsx from "@pulumi/awsx";
import {
  AsyncTest,
  Expect,
  FocusTest,
  IgnoreTest,
  TestFixture,
  Timeout,
} from "alsatian";
import { APIGatewayProxyEvent, Handler } from "aws-lambda";
import * as LambdaTester from "lambda-tester";
import { INote } from "./FanoutGraphqlApolloConfig";
import FanoutGraphqlAppLambdaCallback from "./FanoutGraphqlAppLambdaCallback";
import { MapSimpleTable } from "./SimpleTable";
import { cli } from "./test/cli";

/** Convert a pulumi aws.lambda.Callback to a handler function that can be used with lambda-tester. The types are slightly different */
const PulumiCallbackForLambdaTester = (
  pulumiCallback: pulumiAws.lambda.Callback<
    pulumiAwsx.apigateway.Request,
    pulumiAwsx.apigateway.Response
  >,
): Handler => {
  return (event, context, callback) => {
    const contextForLambdaTester: pulumiAws.lambda.Context = {
      ...context,
      clientContext: context.clientContext || {},
      getRemainingTimeInMillis: () =>
        String(context.getRemainingTimeInMillis()),
      identity: context.identity || {},
      memoryLimitInMB: String(context.memoryLimitInMB),
    };
    return pulumiCallback(event, contextForLambdaTester, callback);
  };
};

/** Given object, return the same with all  lowercased */
const lowerCaseKeys = (headers: object) => {
  const headersWithLowerCaseKeys: { [key: string]: string } = {};
  for (const [header, value] of Object.entries(headers)) {
    headersWithLowerCaseKeys[header.toLowerCase()] = value;
  }
  return headersWithLowerCaseKeys;
};

/** Test Suite for FanoutGraphqlAppLambdaCallback */
@TestFixture()
export class FanoutGraphqlAppLambdaCallbackTest {
  /**
   * Test FanoutGraphqlExpressServer with defaults
   */
  @AsyncTest()
  public async testFanoutGraphqlAppLambdaCallbackForGraphiqlPlayground(
    pushpinGripUrl = process.env.GRIP_URL || "http://localhost:5561",
  ) {
    const handler = FanoutGraphqlAppLambdaCallback({
      grip: {
        url: pushpinGripUrl,
      },
      tables: { notes: MapSimpleTable<INote>() },
    });
    const event: Partial<APIGatewayProxyEvent> = {
      headers: {
        Accept: "text/html, application/json",
      },
      httpMethod: "GET",
      path: "/",
    };
    Expect(typeof handler).toBe("function");
    await LambdaTester(PulumiCallbackForLambdaTester(handler))
      .event(event)
      .expectResult(result => {
        // should be graphiql playground
        Expect(result).toBeTruthy();
        Expect(result.statusCode).toBe(200);
        Expect(typeof result.headers).toBe("object");
        const headers = lowerCaseKeys(result.headers);
        Expect(result.headers["content-type"]).toBe("text/html");
      });
  }
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}
