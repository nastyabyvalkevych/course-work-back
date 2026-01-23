import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
    const app = await NestFactory.create(AppModule)
    const corsOrigin =
        process.env.CORS_ORIGIN ??
        process.env.FRONTEND_URL ??
        'http://localhost:3000'
    const allowedOrigins = corsOrigin
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    app.enableCors({
        origin: allowedOrigins.length <= 1 ? allowedOrigins[0] : allowedOrigins,
    })
    app.useGlobalPipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: false,
        }),
    )
    await app.listen(process.env.PORT ?? 3002)
}
bootstrap()
