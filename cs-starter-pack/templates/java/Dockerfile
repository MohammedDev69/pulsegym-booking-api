# Java template (Maven, e.g. Spring Boot). Builds the jar, then runs it on port 8080.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q dependency:go-offline
COPY src ./src
RUN mvn -q package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/target/*.jar app.jar
EXPOSE 8080
ENV SERVER_PORT=8080
CMD ["java", "-jar", "app.jar"]
